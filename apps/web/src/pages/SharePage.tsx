import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import type { AlbumPhoto } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { LoadingScreen } from "../components/LoadingScreen";
import PasswordInput from "../components/PasswordInput";
import MasonryGrid from "../components/MasonryGrid";
import ProgressiveImg from "../components/ProgressiveImg";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import { useShowLabels } from "../hooks/useShowLabels";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import { downloadFile } from "../lib/downloadFile";

interface ShareContent {
  title: string;
  allowDownload: boolean;
  items: AlbumPhoto[];
}

// Public viewer for a shared album: no nav, no auth, nothing from the owner's private library.
export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [content, setContent] = useState<ShareContent | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [showLabels, setShowLabels] = useShowLabels();
  const [downloadError, setDownloadError] = useState<string | null>(null);

  function load() {
    if (!token) return;
    api
      .get<ShareContent | { needsPassword: true }>(`/share/${token}`)
      .then((res) => {
        if ("needsPassword" in res) setNeedsPassword(true);
        else {
          setNeedsPassword(false);
          setContent(res);
        }
      })
      .catch(() => setNotFound(true));
  }

  useEffect(load, [token]);

  async function unlock(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      await api.post(`/share/${token}/unlock`, { password });
      load();
    } catch (err) {
      setUnlockError(err instanceof ApiError ? err.message : "Incorrect password");
    } finally {
      setUnlocking(false);
    }
  }

  if (notFound) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-canvas px-4 text-center">
        <p className="text-lg font-medium text-ink">This link doesn't exist or is no longer available.</p>
      </div>
    );
  }

  if (needsPassword) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-4">
        <form onSubmit={unlock} className="w-full max-w-sm space-y-3 rounded-lg border border-line bg-surface p-6">
          <h1 className="text-center text-lg font-semibold text-ink">This album is password-protected</h1>
          <PasswordInput
            value={password}
            onChange={setPassword}
            placeholder="Password"
            autoFocus
            autoComplete="current-password"
            className="w-full rounded-md border border-line px-3 py-2 text-sm"
          />
          <FormMessage error={unlockError} />
          <Button type="submit" className="w-full" loading={unlocking} disabled={!password}>
            {unlocking ? "Checking…" : "View album"}
          </Button>
        </form>
      </div>
    );
  }

  if (!content) return <LoadingScreen showBackLink={false} />;

  const downloadFor = (item: AlbumPhoto) =>
    content.allowDownload
      ? {
          url: `/api/share/${token}/photos/${item.photoId}/display?download=1`,
          filename: `${item.commonName || item.scientificName || item.photoId}.webp`,
        }
      : null;

  function download(item: AlbumPhoto) {
    const target = downloadFor(item);
    if (!target) return;
    setDownloadError(null);
    downloadFile(target.url, target.filename).catch(() => setDownloadError("Couldn't download this photo. Try again."));
  }

  const slides: LightboxSlide[] = content.items.map((item) => ({
    url: `/api/share/${token}/photos/${item.photoId}/display`,
    caption: item.commonName || item.scientificName,
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
        <h1 className="text-lg font-semibold text-ink">{content.title}</h1>
        {content.items.length > 0 && (
          <label className="flex items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
            Labels
          </label>
        )}
      </header>

      <main className="p-6">
        <FormMessage error={downloadError} className="mb-4" />
        {content.items.length === 0 ? (
          <p className="text-muted">This album is empty.</p>
        ) : (
          <MasonryGrid
            items={content.items.map((item, i) => ({ item, i }))}
            columnWidth={260}
            gap={8}
            extraHeightPx={showLabels ? 19 : 0}
            keyFor={({ item }) => item.photoId}
            aspectRatioFor={({ item }) => (item.width && item.height ? item.width / item.height : null)}
            renderItem={({ item, i }, aspectRatio) => (
              <div key={item.photoId} className="group relative w-full">
                <button onClick={() => setLightboxIndex(i)} className="block w-full text-left">
                  <div className="overflow-hidden rounded-md" style={{ aspectRatio }}>
                    <ProgressiveImg
                      thumbSrc={`/api/share/${token}/photos/${item.photoId}/thumb`}
                      fullSrc={`/api/share/${token}/photos/${item.photoId}/display`}
                      alt={item.commonName || item.scientificName}
                      className="block h-full w-full cursor-pointer object-cover"
                    />
                  </div>
                  {showLabels && <p className="mt-1 truncate text-[11px] text-muted">{item.commonName || item.scientificName}</p>}
                </button>
                {content.allowDownload && (
                  <button
                    type="button"
                    onClick={() => download(item)}
                    aria-label="Download photo"
                    title="Download"
                    className="absolute right-2 top-2 rounded-full bg-black/50 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/70 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          />
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox slides={slides} index={lightboxIndex} onIndexChange={setLightboxIndex} onClose={() => setLightboxIndex(null)} />
      )}
    </div>
  );
}
