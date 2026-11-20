import { useState } from "react";
import { useTranslation } from "react-i18next";
import FormMessage from "../../components/FormMessage";
import SegmentedControl from "../../components/SegmentedControl";
import PasswordInput from "../../components/PasswordInput";
import { OnlinePlacesChoice } from "../../components/map/MapLayersControl";
import { useOnlineMapPrefs } from "../../hooks/useOnlineMap";
import { customSatelliteUrl, providerNames } from "../../lib/mapStyle";
import { SettingRow } from "./shared";

const PLACEHOLDERS = { z: "{z}", x: "{x}", y: "{y}" };

/** The photo map's online choice (also in its Layers button) and an optional own imagery URL. */
export default function MapSettingsRows() {
  const { t } = useTranslation();
  const prefs = useOnlineMapPrefs();
  const [draft, setDraft] = useState(prefs.satelliteUrl);
  const providers = providerNames(prefs.satelliteUrl);
  const invalid = draft.trim() !== "" && !customSatelliteUrl(draft);
  return (
    <>
      <SettingRow label={t("settings.general.map.mode")} description={t("settings.general.map.modeHelp", providers)}>
        <SegmentedControl
          label={t("settings.general.map.mode")}
          value={prefs.choice}
          onChange={prefs.setChoice}
          options={[
            { value: "auto", label: t("gallery.map.layers.auto") },
            { value: "off", label: t("gallery.map.layers.off") },
            { value: "satellite", label: t("gallery.map.layers.satellite") },
          ]}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.general.map.places")}
        description={t("settings.general.map.placesHelp", { provider: "Photon (komoot)" })}
      >
        <OnlinePlacesChoice />
      </SettingRow>
      <SettingRow label={t("settings.general.map.imageryUrl")} description={t("settings.general.map.imageryUrlHelp")}>
        {/* Masked like a password: the address usually carries the user's key. */}
        <PasswordInput
          ariaLabel={t("settings.general.map.imageryUrl")}
          value={draft}
          placeholder={t("settings.general.map.imageryUrlPlaceholder", PLACEHOLDERS)}
          autoComplete="off"
          className="w-full"
          onChange={setDraft}
          // Saved once it is usable (or cleared), so a half-typed URL never reaches the map.
          onBlur={() => {
            if (!invalid) prefs.setSatelliteUrl(draft.trim());
          }}
        />
        <FormMessage error={invalid ? t("settings.general.map.imageryUrlInvalid", PLACEHOLDERS) : null} />
      </SettingRow>
    </>
  );
}
