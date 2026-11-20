import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import type { AlbumPhoto, SpeciesNameDisplay } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { LoadingScreen } from "../components/LoadingScreen";
import PasswordInput from "../components/PasswordInput";
import MasonryGrid from "../components/MasonryGrid";
import ProgressiveImg from "../components/ProgressiveImg";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import { useShowLabels } from "../hooks/useShowLabels";
import Button, { IconButton } from "../components/Button";
import { OVERLAY_REVEAL } from "../lib/buttonClasses";
import FormMessage from "../components/FormMessage";
import { downloadFile } from "../lib/downloadFile";
import { DEFAULT_SPECIES_NAME_PREFS, normaliseSpeciesNamePrefs, useSpeciesName } from "../lib/speciesName";
import Checkbox from "../components/Checkbox";
import EmptyState from "../components/EmptyState";
import Panel from "../components/Panel";

// Only on a link whose owner turned locations on; a sensitive species has no place, only its region.
type SharedPhoto = AlbumPhoto & {
  location?: { place: string | null; region: string | null; country: string | null } | null;
};

const placeText = (item: SharedPhoto) =>
  [item.location?.place, item.location?.region, item.location?.country].filter(Boolean).join(", ");

interface ShareContent {
  title: string;
  allowDownload: boolean;
  items: SharedPhoto[];
  // The album owner's species name choice.
  speciesNames?: SpeciesNameDisplay | null;
}

// Public viewer for a shared album: no nav, no auth, nothing from the owner's private library.
export default function SharePage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [content, setContent] = useState<ShareContent | null>(null);
  // The owner's order, never this browser's own View menu choice.
  const ownerNames = useMemo(() => normaliseSpeciesNamePrefs(content?.speciesNames), [content?.speciesNames]);
  const speciesName = useSpeciesName(ownerNames ?? DEFAULT_SPECIES_NAME_PREFS);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showLabels, setShowLabels] = useShowLabels();
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // The newest load wins; an older one still in flight is cancelled.
  const loadRef = useRef<AbortController | null>(null);
  function load() {
    if (!token) return;
    loadRef.current?.abort();
    const controller = new AbortController();
    loadRef.current = controller;
    api
      .get<ShareContent | { needsPassword: true }>(`/share/${token}`, { signal: controller.signal })
      .then((res) => {
        if ("needsPassword" in res) setNeedsPassword(true);
        else {
          setNeedsPassword(false);
          setContent(res);
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Missing, expired and revoked links all answer 404; anything else is worth a retry.
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setLoadFailed(true);
      });
  }

  useEffect(() => {
    load();
    return () => loadRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is rebuilt every render; it only reads token
  }, [token]);

  async function unlock(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      await api.post(`/share/${token}/unlock`, { password });
      load();
    } catch (err) {
      setUnlockError(err instanceof ApiError ? err.message : t("share.incorrectPassword"));
    } finally {
      setUnlocking(false);
    }
  }

  if (notFound) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-canvas px-4 text-center">
        <p className="text-title-3 font-medium text-ink">{t("share.notFound")}</p>
      </div>
    );
  }

  if (loadFailed && !content) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-canvas px-4 text-center">
        <p className="text-title-3 font-medium text-ink">{t("share.loadFailed")}</p>
        <Button
          onClick={() => {
            setLoadFailed(false);
            load();
          }}
        >
          {t("share.tryAgain")}
        </Button>
      </div>
    );
  }

  if (needsPassword) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-4">
        <Panel as="form" onSubmit={unlock} className="w-full max-w-sm space-y-3">
          <h1 className="text-center text-title-2 font-semibold text-ink">{t("share.passwordProtected")}</h1>
          <PasswordInput
            value={password}
            onChange={setPassword}
            placeholder={t("share.password")}
            autoFocus
            autoComplete="current-password"
          />
          <FormMessage error={unlockError} />
          <Button type="submit" className="w-full" loading={unlocking} disabled={!password}>
            {unlocking ? t("share.checking") : t("share.viewAlbum")}
          </Button>
        </Panel>
      </div>
    );
  }

  if (!content) return <LoadingScreen showBackLink={false} />;

  const downloadFor = (item: AlbumPhoto) =>
    content.allowDownload
      ? {
          url: `/api/share/${token}/photos/${item.photoId}/display?download=1`,
          filename: `${speciesName(item) || item.photoId}.webp`,
        }
      : null;

  function download(item: AlbumPhoto) {
    const target = downloadFor(item);
    if (!target) return;
    setDownloadError(null);
    downloadFile(target.url, target.filename).catch(() => setDownloadError(t("share.downloadFailed")));
  }

  const slides: LightboxSlide[] = content.items.map((item) => ({
    url: `/api/share/${token}/photos/${item.photoId}/display`,
    caption: [speciesName(item), placeText(item)].filter(Boolean).join(" · "),
    download: downloadFor(item),
    info: {
      cameraModel: item.cameraModel,
      lens: item.lens,
      focalLengthMm: item.focalLengthMm,
      aperture: item.aperture,
      shutter: item.shutter,
      iso: item.iso,
    },
  }));

  return (
    <div className="min-h-screen bg-canvas">
      <header className="flex items-center justify-between border-b border-line bg-surface px-6 py-4">
        <h1 className="text-title-2 font-semibold text-ink">{content.title}</h1>
        {content.items.length > 0 && (
          <Checkbox checked={showLabels} onChange={setShowLabels} labelClassName="text-muted">
            {t("share.labels")}
          </Checkbox>
        )}
      </header>

      <main className="space-y-section p-page">
        <FormMessage error={downloadError} />
        {content.items.length === 0 ? (
          <EmptyState title={t("share.empty")} />
        ) : (
          <MasonryGrid
            items={content.items.map((item, i) => ({ item, i }))}
            columnWidth={260}
            keyFor={({ item }) => item.photoId}
            aspectRatioFor={({ item }) => (item.width && item.height ? item.width / item.height : null)}
            renderItem={({ item, i }, aspectRatio) => (
              <div key={item.photoId} className="group relative w-full">
                {/* raw-control: the whole photo tile is the button */}
                <button onClick={() => setLightboxIndex(i)} className="block w-full text-left">
                  <div className="overflow-hidden rounded-control" style={{ aspectRatio }}>
                    <ProgressiveImg
                      thumbSrc={`/api/share/${token}/photos/${item.photoId}/thumb`}
                      fullSrc={`/api/share/${token}/photos/${item.photoId}/display`}
                      alt={speciesName(item)}
                      className="block h-full w-full cursor-pointer object-cover"
                    />
                  </div>
                  {showLabels && <p className="mt-1 truncate text-caption text-muted">{speciesName(item)}</p>}
                </button>
                {content.allowDownload && (
                  // The shared overlay pill, in the corner where a tile's ⋯ sits.
                  <IconButton
                    tone="overlay"
                    onClick={() => download(item)}
                    aria-label={t("share.downloadPhoto")}
                    tooltip={{ label: t("share.download") }}
                    className={`absolute right-2 top-1.5 ${OVERLAY_REVEAL}`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
                    </svg>
                  </IconButton>
                )}
              </div>
            )}
          />
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox
          slides={slides}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
