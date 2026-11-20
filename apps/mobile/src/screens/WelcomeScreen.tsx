import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Button, Screen } from "../ui";

/** First run: connect to a Lifer, or use the app on its own. Both can change later. */
export function WelcomeScreen({ onConnect, onStandalone }: { onConnect: () => void; onStandalone: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <Screen safeTop padded={false}>
      <View style={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: 24, gap: 12 }}>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type["large-title"].size, fontWeight: "700" }}>
          {t("welcome.title")}
        </Text>
        <Text style={{ color: colors.muted, fontSize: type.body.size }}>{t("welcome.body")}</Text>
      </View>
      <View style={{ paddingHorizontal: 16, gap: 10 }}>
        <Text style={{ color: colors.muted, fontSize: type.footnote.size, textAlign: "center", paddingHorizontal: 8 }}>{t("welcome.connectHint")}</Text>
        <Button label={t("welcome.connect")} icon="sync" onPress={onConnect} />
        <Text style={{ color: colors.muted, fontSize: type.footnote.size, textAlign: "center", paddingHorizontal: 8, paddingTop: 8 }}>{t("welcome.standaloneHint")}</Text>
        <Button variant="secondary" label={t("welcome.standalone")} onPress={onStandalone} />
      </View>
    </Screen>
  );
}
