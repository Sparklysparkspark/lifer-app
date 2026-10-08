import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

// Real history back, so the collection's URL-held filters survive; `fallbackTo` when there's no
// earlier page in this visit. That's React Router's own position in the history (`idx`), not
// `location.key`: a page opened from a pasted URL and then redirected (signing in first, say)
// has a key but nothing of the app's behind it, and going back would leave the app for a blank
// tab. The label can come from `location.state.backLabel`.
function hasEarlierPage(): boolean {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && idx > 0;
}

export default function BackToCollectionLink({
  fallbackTo = "/",
  label,
  className,
}: {
  fallbackTo?: string;
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { backLabel?: string } | null;
  return (
    <button
      onClick={() => {
        if (hasEarlierPage()) navigate(-1);
        else navigate(fallbackTo);
      }}
      className={className}
    >
      ← {state?.backLabel ?? label ?? t("nav.collection")}
    </button>
  );
}
