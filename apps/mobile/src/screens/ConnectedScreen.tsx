import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { hubLabelKey, type PairedHub } from "../connection/pair";
import { spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Button, Screen } from "../ui";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Shown right after pairing and whenever the phone is paired: who it is connected to, and how to leave. */
export function ConnectedScreen({ paired, onForget }: { paired: PairedHub; onForget: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const hub = t(hubLabelKey(paired.hub.kind));
  // Destructive, so a system alert is allowed (MR3).
  const confirm = () =>
    Alert.alert(t("pair.disconnectTitle", { hub }), t("pair.disconnectMessage"), [
      { text: t("pair.cancel"), style: "cancel" },
      { text: t("pair.disconnectConfirm"), style: "destructive", onPress: onForget },
    ]);
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", gap: spacing.item }}>
        <Text
          accessibilityRole="header"
          accessibilityLiveRegion="polite"
          style={{ color: colors.ink, fontSize: type["title-1"].size, fontWeight: "700" }}
        >
          {t("pair.connected", { hub })}
        </Text>
        <Text style={{ color: colors.muted, fontSize: type.body.size }}>
          {t("pair.connectedAt", { address: hostOf(paired.hub.baseUrl) })}
        </Text>
      </View>
      <Button variant="plain" label={t("pair.disconnect")} onPress={confirm} />
    </Screen>
  );
}
