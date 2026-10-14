import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { useGoBack } from "../hooks/useGoBack";

// Every page's back control (via PageHeader), not only the species page's. The label can come from
// `location.state.backLabel` (see lib/backLabel.ts), the fallback from `location.state.backTo`.
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
  const goBack = useGoBack();
  const state = useLocation().state as { backLabel?: string } | null;
  return (
    <button onClick={() => goBack(fallbackTo)} className={className}>
      ← {state?.backLabel ?? label ?? t("nav.collection")}
    </button>
  );
}
