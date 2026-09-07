import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { AlbumPhoto } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { LoadingScreen, Spinner } from "../components/LoadingScreen";
import PasswordInput from "../components/PasswordInput";
import PageHeader from "../components/PageHeader";
import MasonryGrid from "../components/MasonryGrid";
import PhotoTile from "../components/PhotoTile";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { useShowLabels } from "../hooks/useShowLabels";
import { useDesktopMode } from "../hooks/useDesktopMode";
import RenameModal from "../components/RenameModal";

interface AlbumDetail {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  items: AlbumPhoto[];
}

interface ShareLink {
  id: string;
  token: string;
  hasPassword: boolean;
  allowDownload: boolean;
  showMetadata: boolean;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}

export default function AlbumDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [thumbSizePx] = usePhotoGridSize();
  const [showLabels, setShowLabels] = useShowLabels();
  const { openKey: openMenuKey, setOpenKey: setOpenMenuKey, ref: openMenuRef } = useDropdownMenu<string>();
  const isDesktopMode = useDesktopMode();
  const [renaming, setRenaming] = useState(false);

  const [shares, setShares] = useState<ShareLink[] | null>(null);
  const [showSharePanel, setShowSharePanel] = useState(false);
  const [creatingShare, setCreatingShare] = useState(false);
  const [sharePassword, setSharePassword] = useState("");
  const [shareAllowDownload, setShareAllowDownload] = useState(false);
  const [shareShowMetadata, setShareShowMetadata] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  function load() {
    if (!id) return;
    setLoadError(false);
    api
      .get<AlbumDetail>(`/albums/${id}`)
      .then(setAlbum)
      .catch(() => setLoadError(true));
  }

  useEffect(load, [id]);

  function loadShares() {
    if (!id) return;
    api.get<{ shares: ShareLink[] }>(`/albums/${id}/shares`).then((res) => setShares(res.shares));
  }

  async function removeFromAlbum(captureId: string) {
    if (!id || !album) return;
    setAlbum({ ...album, items: album.items.filter((i) => i.captureId !== captureId) });
    await api.delete(`/albums/${id}/captures/${captureId}`);
  }

  async function renameAlbum(name: string) {
    if (!id) return;
    await api.patch(`/albums/${id}`, { name });
    setRenaming(false);
    load();
  }

  async function setCoverPhoto(photoId: string) {
    if (!id) return;
    setOpenMenuKey(null);
    await api.patch(`/albums/${id}`, { coverPhotoId: photoId });
    load();
  }

  async function createShare(e: React.FormEvent) {
    e.preventDefault();
    if (!id) return;
    setCreatingShare(true);
    setShareError(null);
    try {
      await api.post(`/albums/${id}/shares`, {
        password: sharePassword.trim() || undefined,
        allowDownload: shareAllowDownload,
        showMetadata: shareShowMetadata,
      });
      setSharePassword("");
      loadShares();
    } catch (err) {
      setShareError(err instanceof ApiError ? err.message : "Couldn't create this share link");
    } finally {
      setCreatingShare(false);
    }
  }

  async function revokeShare(shareId: string) {
    await api.delete(`/shares/${shareId}`);
    loadShares();
  }

  if (loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <p className="text-muted">Couldn't load this album.</p>
        <button onClick={load} className="text-sm text-ink underline">
          Retry
        </button>
      </div>
    );
  }
  if (!album) return <LoadingScreen />;

  const slides: LightboxSlide[] = album.items.map((item) => ({
    url: `/api/photos/${item.photoId}/display`,
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
      <PageHeader
        title={album.name}
        backFallbackTo="/albums"
        backLabel="Albums"
        actions={
          <>
            <label className="flex items-center gap-1.5 text-sm text-muted">
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
              Labels
            </label>
            <button
              onClick={() => setRenaming(true)}
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Edit album
            </button>
            <Link
              to="/gallery?select=1"
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              Add photos
            </Link>
            {/* Sharing only makes sense in server/self-hosted mode — desktop runs on localhost
               with no public URL to hand out, and SINGLE_USER_MODE has no real session system
               underneath the owner-side management endpoints to protect (see the plan this was
               built from). */}
            {!isDesktopMode && (
              <button
                onClick={() => {
                  setShowSharePanel((s) => !s);
                  if (!shares) loadShares();
                }}
                className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-muted"
              >
                {showSharePanel ? "Hide sharing" : "Share…"}
              </button>
            )}
          </>
        }
      />

      {showSharePanel && !isDesktopMode && (
        <div className="border-b border-line bg-surface-muted px-6 py-4">
          <div className="max-w-lg space-y-3">
            <form onSubmit={createShare} className="space-y-2 rounded-lg border border-line bg-surface p-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink">Password (optional)</label>
                <PasswordInput
                  value={sharePassword}
                  onChange={setSharePassword}
                  placeholder="Leave blank for no password"
                  autoComplete="new-password"
                  className="w-full rounded-md border border-line px-3 py-1.5 text-sm"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={shareAllowDownload} onChange={(e) => setShareAllowDownload(e.target.checked)} />
                Allow visitors to download photos
              </label>
              <div>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={shareShowMetadata} onChange={(e) => setShareShowMetadata(e.target.checked)} />
                  Show camera info (lens, settings)
                </label>
                <p className="mt-0.5 pl-6 text-xs text-muted">Location data is never included in a shared link, regardless of this setting.</p>
              </div>
              {shareError && <p className="text-sm text-red-600">{shareError}</p>}
              <button
                type="submit"
                disabled={creatingShare}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-50"
              >
                {creatingShare ? "Creating…" : "Create share link"}
              </button>
            </form>

            {shares && shares.length > 0 && (
              <ul className="space-y-2">
                {shares.map((share) => {
                  const url = `${window.location.origin}/share/${share.token}`;
                  return (
                    <li
                      key={share.id}
                      className={`flex items-center justify-between gap-2 rounded-md border border-line bg-surface p-2 text-sm ${
                        share.revoked ? "opacity-50" : ""
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="truncate">{share.revoked ? "Revoked" : url}</p>
                        <p className="text-xs text-muted">
                          {share.hasPassword ? "Password-protected" : "No password"}
                          {share.allowDownload ? " · Downloads allowed" : ""}
                        </p>
                      </div>
                      {!share.revoked && (
                        <div className="flex shrink-0 gap-2">
                          <button
                            onClick={() => navigator.clipboard.writeText(url)}
                            className="rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-muted"
                          >
                            Copy
                          </button>
                          <button
                            onClick={() => revokeShare(share.id)}
                            className="rounded-md border border-line px-2 py-1 text-xs text-red-600 hover:bg-surface-muted"
                          >
                            Revoke
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      <main className="p-6">
        {album.items.length === 0 ? (
          <p className="text-muted">No photos in this album yet. Add some from the Gallery, a Trip, or a species page.</p>
        ) : (
          <MasonryGrid
            items={album.items.map((item, i) => ({ item, i }))}
            columnWidth={thumbSizePx}
            gap={8}
            extraHeightPx={showLabels ? 19 : 0}
            keyFor={({ item }) => item.photoId}
            aspectRatioFor={({ item }) => (item.width && item.height ? item.width / item.height : null)}
            renderItem={({ item, i }, aspectRatio) => (
              <PhotoTile
                key={item.photoId}
                photoId={item.photoId}
                alt={item.commonName || item.scientificName}
                onOpen={() => setLightboxIndex(i)}
                selectMode={false}
                selected={false}
                onToggleSelect={() => {}}
                aspectRatio={aspectRatio}
                menuOpen={openMenuKey === item.photoId}
                onToggleMenu={() => setOpenMenuKey(openMenuKey === item.photoId ? null : item.photoId)}
                menuRef={openMenuRef}
                menuContent={
                  <div className="absolute right-0 top-full z-10 mt-1 w-44 rounded-md border border-line bg-surface py-1 shadow-lg">
                    <button
                      onClick={() => setCoverPhoto(item.photoId)}
                      disabled={album.coverPhotoId === item.photoId}
                      className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50"
                    >
                      {album.coverPhotoId === item.photoId ? "Album cover ✓" : "Set as album cover"}
                    </button>
                    <button
                      onClick={() => {
                        removeFromAlbum(item.captureId);
                        setOpenMenuKey(null);
                      }}
                      className="block w-full border-t border-line px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted"
                    >
                      Remove from album
                    </button>
                  </div>
                }
                label={
                  showLabels && <p className="mt-1 truncate text-[11px] text-muted">{item.commonName || item.scientificName}</p>
                }
              />
            )}
          />
        )}
      </main>

      {lightboxIndex !== null && (
        <Lightbox slides={slides} index={lightboxIndex} onIndexChange={setLightboxIndex} onClose={() => setLightboxIndex(null)} />
      )}

      {renaming && (
        <RenameModal title="Rename album" initialName={album.name} onCancel={() => setRenaming(false)} onSave={renameAlbum} />
      )}
    </div>
  );
}
