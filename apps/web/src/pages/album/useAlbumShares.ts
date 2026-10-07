import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../api/client";
import { useNow } from "../../hooks/useNow";
import { useToast } from "../../hooks/useToast";
import type { ShareLink } from "./types";

export const SHARE_EXPIRY_OPTIONS = [
  { value: "never", label: "Never", days: null },
  { value: "1", label: "1 day", days: 1 },
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
] as const;
export type ShareExpiry = (typeof SHARE_EXPIRY_OPTIONS)[number]["value"];

// Share links and the form that makes them. Kept by the page rather than the panel, so hiding
// the panel keeps the loaded links and a half-filled form.
export function useAlbumShares(albumId: string | undefined) {
  const toast = useToast();
  const [shares, setShares] = useState<ShareLink[] | null>(null);
  // Compared with each link's expiry; ticking means a link that expires while the page is open greys out.
  const now = useNow(60_000);
  const [showPanel, setShowPanel] = useState(false);
  const [creating, setCreating] = useState(false);
  const [password, setPassword] = useState("");
  const [allowDownload, setAllowDownload] = useState(false);
  const [showMetadata, setShowMetadata] = useState(false);
  const [expiry, setExpiry] = useState<ShareExpiry>("never");
  const [error, setError] = useState<string | null>(null);

  function loadShares() {
    if (!albumId) return;
    api
      .get<{ shares: ShareLink[] }>(`/albums/${albumId}/shares`)
      .then((res) => setShares(res.shares))
      .catch(() => toast.error("Couldn't load share links."));
  }

  // The links load the first time the panel opens.
  function togglePanel() {
    setShowPanel((s) => !s);
    if (!shares) loadShares();
  }

  async function createShare(e: FormEvent) {
    e.preventDefault();
    if (!albumId) return;
    setCreating(true);
    setError(null);
    const days = SHARE_EXPIRY_OPTIONS.find((o) => o.value === expiry)?.days ?? null;
    try {
      await api.post(`/albums/${albumId}/shares`, {
        password: password.trim() || undefined,
        allowDownload,
        showMetadata,
        expiresAt: days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null,
      });
      setPassword("");
      loadShares();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create this share link");
    } finally {
      setCreating(false);
    }
  }

  async function revokeShare(shareId: string) {
    try {
      await api.delete(`/shares/${shareId}`);
    } catch {
      toast.error("Couldn't revoke this share link.");
    }
    loadShares();
  }

  function copyShareUrl(url: string) {
    // navigator.clipboard is missing on plain-http origins, e.g. a server reached over the LAN.
    (navigator.clipboard?.writeText(url) ?? Promise.reject()).then(
      () => toast.success("Link copied"),
      () => toast.error("Couldn't copy the link."),
    );
  }

  return {
    shares,
    now,
    showPanel,
    togglePanel,
    form: {
      password,
      setPassword,
      allowDownload,
      setAllowDownload,
      showMetadata,
      setShowMetadata,
      expiry,
      setExpiry,
      error,
      creating,
    },
    createShare,
    revokeShare,
    copyShareUrl,
  };
}

export type AlbumShares = ReturnType<typeof useAlbumShares>;
