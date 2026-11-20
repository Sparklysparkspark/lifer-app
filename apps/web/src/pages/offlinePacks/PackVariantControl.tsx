import { useTranslation } from "react-i18next";
import SegmentedControl from "../../components/SegmentedControl";
import InfoTip from "../../components/InfoTip";
import type { DownloadVariant } from "../../lib/packIndex";

const VARIANT_INFO_PARAGRAPH_KEYS = [
  "offlinePacks.variant.info.full",
  "offlinePacks.variant.info.small",
  "offlinePacks.variant.info.upgrade",
];

/** Full or Small, with what each means, for every screen that starts a species download. */
export default function PackVariantControl({
  value,
  onChange,
}: {
  value: DownloadVariant;
  onChange: (value: DownloadVariant) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <SegmentedControl
        value={value}
        onChange={onChange}
        options={[
          { value: "full", label: t("offlinePacks.variant.full") },
          { value: "small", label: t("offlinePacks.variant.small") },
        ]}
      />
      <InfoTip paragraphs={VARIANT_INFO_PARAGRAPH_KEYS.map((key) => t(key))} />
    </div>
  );
}
