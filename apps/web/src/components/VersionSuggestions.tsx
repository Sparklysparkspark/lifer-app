// The review of suggested photo versions (same shutter press, different names) after an import.
// Inline and dismissable, never a blocking dialog; nothing shows when there's nothing to review.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { useApiRoute } from "../lib/resource";
import { errorMessage } from "../lib/errorMessage";
import { useToast } from "../hooks/useToast";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { shortcutLabel } from "../lib/keymap";
import { photoSlide } from "../lib/photoSlide";
import Button from "./Button";
import { useLightbox } from "./Lightbox";

type Suggestion = ApiResponse<"/captures/version-suggestions">["suggestions"][number];

// Rows render in pages, so a big import's hundreds of pairs stay quick.
const PAGE_SIZE = 50;

export default function VersionSuggestions() {
  const { t } = useTranslation();
  const toast = useToast();
  const res = useApiRoute(apiPath("/captures/version-suggestions", {}));
  const list = res.data?.suggestions ?? [];
  const [shown, setShown] = useState(PAGE_SIZE);
  const viewer = useLightbox();

  const decide = async (accept: boolean, captureIds: string[]) => {
    if (captureIds.length === 0) return;
    try {
      if (accept) await api.post("/captures/version-suggestions/accept", { captureIds });
      else await api.post("/captures/version-suggestions/dismiss", { captureIds });
      await res.reload();
      toast.show(
        accept ? t("versions.review.linkedToast", { count: captureIds.length }) : t("versions.review.dismissedToast"),
        {
          actions: [
            {
              label: t("versions.undo"),
              onClick: () =>
                void (
                  accept
                    ? Promise.all(
                        captureIds.map((id) => api.post(apiPath("/captures/{id}/versions/split", { id }))),
                      ).then(() => api.post("/captures/version-suggestions/restore", { captureIds }))
                    : api.post("/captures/version-suggestions/restore", { captureIds })
                )
                  .then(() => res.reload())
                  .catch((err) => toast.error(errorMessage(err, t("versions.failed")))),
            },
          ],
        },
      );
    } catch (err) {
      toast.error(errorMessage(err, t("versions.failed")));
    }
  };

  // The row holding keyboard focus, so a bound key acts on what the user is looking at.
  const focusedRow = (): Suggestion | undefined => {
    const id = (document.activeElement?.closest("[data-capture-id]") as HTMLElement | null)?.dataset.captureId;
    return list.find((s) => s.captureId === id);
  };
  useKeyboardShortcuts(
    {
      // Mod chords: the browser's own meaning (find next, a focused button's click) is dropped.
      versionReviewLinkAll: (e) => {
        e.preventDefault();
        void decide(
          true,
          list.map((s) => s.captureId),
        );
      },
      versionReviewLink: (e) => {
        e.preventDefault();
        const s = focusedRow();
        if (s) void decide(true, [s.captureId]);
      },
      versionReviewDismiss: (e) => {
        e.preventDefault();
        const s = focusedRow();
        if (s) void decide(false, [s.captureId]);
      },
    },
    { enabled: list.length > 0 },
  );

  if (list.length === 0) return null;
  // Either thumbnail opens both full size, to tell whether they're the same photo.
  const pair = (s: Suggestion) =>
    [s.groupPhotoId, s.photoId].flatMap((photoId) => (photoId ? [photoSlide({ photoId })] : []));
  const thumb = (s: Suggestion, photoId: string | null, name: string | null) =>
    photoId ? (
      // raw-control: the whole thumbnail opens the pair full size, as on a photo tile.
      <button
        type="button"
        aria-label={t("versions.viewFile", { name: name ?? "" })}
        onClick={() => viewer.open(pair(s), photoId === s.groupPhotoId ? 0 : pair(s).length - 1)}
        className="h-20 w-20 shrink-0 overflow-hidden rounded-control bg-surface-muted transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <img src={`/api/photos/${photoId}/thumb`} alt="" loading="lazy" className="h-full w-full object-cover" />
      </button>
    ) : (
      <span className="h-20 w-20 shrink-0 rounded-control bg-surface-muted" />
    );

  return (
    <section aria-labelledby="version-suggestions-title" className="space-y-item">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="version-suggestions-title" className="text-callout font-semibold text-ink">
            {t("versions.review.title", { count: list.length })}
          </h2>
          <p className="text-footnote text-muted">{t("versions.review.description")}</p>
        </div>
        <Button
          size="sm"
          tooltip={{ label: t("versions.review.linkAll"), shortcut: shortcutLabel("versionReviewLinkAll") }}
          onClick={() =>
            void decide(
              true,
              list.map((s) => s.captureId),
            )
          }
        >
          {t("versions.review.linkAll")}
        </Button>
      </div>
      <ul className="divide-y divide-line">
        {list.slice(0, shown).map((s) => (
          <li key={s.captureId} data-capture-id={s.captureId} className="flex flex-wrap items-center gap-3 py-2">
            <div className="flex shrink-0 gap-2">
              {thumb(s, s.groupPhotoId, s.groupFileName)}
              {thumb(s, s.photoId, s.fileName)}
            </div>
            <div className="min-w-0 flex-1 text-footnote text-muted">
              {[s.groupFileName, s.fileName].map(
                (name, i) =>
                  name && (
                    <p key={i} className="wrap-anywhere">
                      {name}
                    </p>
                  ),
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="secondary"
                tooltip={{ label: t("versions.review.notSame"), shortcut: shortcutLabel("versionReviewDismiss") }}
                onClick={() => void decide(false, [s.captureId])}
              >
                {t("versions.review.notSame")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                tooltip={{ label: t("versions.review.link"), shortcut: shortcutLabel("versionReviewLink") }}
                onClick={() => void decide(true, [s.captureId])}
              >
                {t("versions.review.link")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {list.length > shown && (
        <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE_SIZE)}>
          {t("manageList.showMore", { count: Math.min(PAGE_SIZE, list.length - shown) })}
        </Button>
      )}
      {viewer.node}
    </section>
  );
}
