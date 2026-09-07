import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { AlbumPhoto } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { LoadingScreen } from "../components/LoadingScreen";
import PasswordInput from "../components/PasswordInput";
import MasonryGrid from "../components/MasonryGrid";
import ProgressiveImg from "../components/ProgressiveImg";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import { useShowLabels } from "../hooks/useShowLabels";

interface ShareContent {
  title: string;
  allowDownload: boolean;
  items: AlbumPhoto[];
}

// The public, unauthenticated viewer for a shared album — deliberately its own standalone page
// with no nav bar, no hint of the owner's private library, and no dependency on RequireAuth. A
// visitor here has no account and needs none.
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

  async function unlock(e: React.FormEvent) {
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
          {unlockError && <p className="text-sm text-red-600">{unlockError}</p>}
          <button
            type="submit"
            disabled={unlocking || !password}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
          >
            {unlocking ? "Checking…" : "View album"}
          </button>
        </form>
      </div>
    );
  }

  if (!content) return <LoadingScreen showBackLink={false} />;

  const slides: LightboxSlide[] = content.items.map((item) => ({
    url: `/api/share/${token}/photos/${item.photoId}/display`,
    caption: item.commonName || item.scientificName,
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
              <button key={item.photoId} onClick={() => setLightboxIndex(i)} className="block w-full text-left">
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
