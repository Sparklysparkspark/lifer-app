import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import InlineSpinner from "./InlineSpinner";

// The app's one loading state. LoadingScreen takes the full viewport when nothing else has
// rendered; Spinner sits inside an already-rendered layout.
export function Spinner({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex flex-col items-center gap-3 py-16 text-muted">
      <InlineSpinner size="md" />
      <p className="text-callout">{label ?? t("common.loading")}</p>
    </div>
  );
}

// The back link is an escape hatch if a load hangs; "/" is safe even before auth resolves.
// Pass showBackLink={false} when the caller already renders its own back link.
export function LoadingScreen({ showBackLink = true, label }: { showBackLink?: boolean; label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-canvas">
      {showBackLink && (
        <Link to="/" className="back-link-corner absolute left-4 top-4 text-callout text-muted hover:underline">
          {t("ui.backToCollection")}
        </Link>
      )}
      <Spinner label={label} />
    </div>
  );
}
