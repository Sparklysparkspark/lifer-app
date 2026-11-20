// The review of suggested photo versions (same shutter press, different names) after an import.
// Inline and dismissable, never a blocking dialog; nothing shows when there's nothing to review.
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { useApiRoute } from "../lib/resource";
import { errorMessage } from "../lib/errorMessage";
import { useToast } from "../hooks/useToast";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { shortcutLabel } from "../lib/keymap";
import Button from "./Button";

type Suggestion = ApiResponse<"/captures/version-suggestions">["suggestions"][number];

export default function VersionSuggestions() {
  const { t } = useTranslation();
  const toast = useToast();
  const res = useApiRoute(apiPath("/captures/version-suggestions", {}));
  const list = res.data?.suggestions ?? [];

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
  const thumb = (photoId: string | null) =>
    photoId ? (
      <img
        src={`/api/photos/${photoId}/thumb`}
        alt=""
        className="h-20 w-20 rounded-control bg-surface-muted object-cover"
      />
    ) : (
      <span className="h-20 w-20 rounded-control bg-surface-muted" />
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
        {list.map((s) => (
          <li key={s.captureId} data-capture-id={s.captureId} className="flex flex-wrap items-center gap-3 py-2">
            <div className="flex shrink-0 gap-2">
              {thumb(s.groupPhotoId)}
              {thumb(s.photoId)}
            </div>
            <p className="min-w-0 flex-1 break-all text-footnote text-muted">
              {[s.groupFileName, s.fileName].filter(Boolean).join(" · ")}
            </p>
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
    </section>
  );
}
