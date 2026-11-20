import { useState, type FormEvent } from "react";
import { api, apiPath, ApiError } from "../../api/client";
import { useNow } from "../../hooks/useNow";
import { useConfirm } from "../../hooks/useConfirm";
import { useToast } from "../../hooks/useToast";
import type { ShareLink } from "./types";
import i18n from "../../i18n";

// Labels are i18n keys.
export const SHARE_EXPIRY_OPTIONS = [
  { value: "never", labelKey: "albums.share.expiry.never", days: null },
  { value: "1", labelKey: "albums.share.expiry.oneDay", days: 1 },
  { value: "7", labelKey: "albums.share.expiry.sevenDays", days: 7 },
  { value: "30", labelKey: "albums.share.expiry.thirtyDays", days: 30 },
] as const;
export type ShareExpiry = (typeof SHARE_EXPIRY_OPTIONS)[number]["value"];

// Share links and the form that makes them. Kept by the page rather than the panel, so hiding
// the panel keeps the loaded links and a half-filled form.
export function useAlbumShares(albumId: string | undefined) {
  const toast = useToast();
  const confirm = useConfirm();
  const [shares, setShares] = useState<ShareLink[] | null>(null);
  // Compared with each link's expiry; ticking means a link that expires while the page is open greys out.
  const now = useNow(60_000);
  const [showPanel, setShowPanel] = useState(false);
  const [creating, setCreating] = useState(false);
  const [password, setPassword] = useState("");
  const [allowDownload, setAllowDownload] = useState(false);
  const [showMetadata, setShowMetadata] = useState(false);
  const [showExactLocations, setShowExactLocations] = useState(false);
  const [expiry, setExpiry] = useState<ShareExpiry>("never");
  const [error, setError] = useState<string | null>(null);

  function loadShares() {
    if (!albumId) return;
    api
      .get(apiPath("/albums/{id}/shares", { id: albumId }))
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
      const created = await api.post(apiPath("/albums/{id}/shares", { id: albumId }), {
        password: password.trim() || undefined,
        allowDownload,
        showMetadata,
        showExactLocations,
        expiresAt: days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null,
      });
      setPassword("");
      loadShares();
      // The clipboard can refuse once the request has used up the click, so failing isn't an error here.
      (navigator.clipboard?.writeText(`${window.location.origin}/share/${created.token}`) ?? Promise.reject()).then(
        () => toast.success("Link created and copied"),
        () => toast.success("Link created. Copy it from the list below."),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create this share link");
    } finally {
      setCreating(false);
    }
  }

  async function revokeShare(shareId: string) {
    const ok = await confirm({
      title: "Revoke this share link?",
      message: "Anyone with this link loses access.",
      confirmLabel: "Revoke",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(apiPath("/shares/{id}", { id: shareId }));
    } catch {
      toast.error("Couldn't revoke this share link.");
    }
    loadShares();
  }

  async function setExactLocations(shareId: string, enabled: boolean) {
    try {
      await api.put(apiPath("/shares/{id}/exact-locations", { id: shareId }), { enabled });
    } catch {
      toast.error(i18n.t("albums.share.locationsFailed"));
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
      showExactLocations,
      setShowExactLocations,
      expiry,
      setExpiry,
      error,
      creating,
    },
    createShare,
    revokeShare,
    setExactLocations,
    copyShareUrl,
  };
}

export type AlbumShares = ReturnType<typeof useAlbumShares>;
