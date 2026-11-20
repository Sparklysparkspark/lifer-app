import { useTranslation } from "react-i18next";
import Button from "./Button";

// The Select/Cancel toggle every multi-select grid uses.
export default function SelectModeToggle({
  active,
  onEnter,
  onExit,
}: {
  active: boolean;
  onEnter: () => void;
  onExit: () => void;
}) {
  const { t } = useTranslation();
  return (
    // Same look as the inactive Filters pill beside it; a plain button since it isn't a toggle state.
    <Button variant="secondary" size="sm" onClick={active ? onExit : onEnter}>
      {active ? t("common.cancel") : t("ui.select")}
    </Button>
  );
}
