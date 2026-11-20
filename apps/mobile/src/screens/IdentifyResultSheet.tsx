import { useEffect } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { changeMark } from "../app/actions";
import { useApp, useLocal } from "../app/AppContext";
import { useSheetHeader } from "../navigation/useHeader";
import { useNav, type RootParams } from "../navigation/types";
import { CachedTile } from "../photos/CachedTile";
import { getSpecies } from "../store/marks";
import { radius, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Button, Screen, haptics, useToast } from "../ui";
import { rememberCheck, verdictKey } from "./IdentifyScreen";
import { VERDICT_LINE, VERDICT_TITLE } from "../labels";

/** The verdict in plain words over the person's own photo. Nothing is added without a tap (P-16). */
export function IdentifyResultSheet({ route }: { route: { params: RootParams["IdentifyResult"] } }) {
  const { photoUri, scientificName } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const app = useApp();
  const nav = useNav();
  const toast = useToast();
  useSheetHeader();
  const { data: row } = useLocal((db) => getSpecies(db, scientificName ?? ""), [scientificName]);

  useEffect(() => {
    if (scientificName) void rememberCheck(app.db, { scientificName, photoUri }).then(app.bump);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scientificName]);

  if (!row) return <Screen>{null}</Screen>;
  const name = row.commonName ?? row.scientificName;
  const markSeen = async () => {
    await changeMark(app, row.scientificName, { state: "seen" });
    haptics.success();
    toast.show(t("toast.seen", { name }), () => void changeMark(app, row.scientificName, { state: null }));
    nav.goBack();
  };
  const toggleTarget = async () => {
    await changeMark(app, row.scientificName, { isTarget: !row.isTarget });
    haptics.selection();
  };

  return (
    <Screen>
      <View>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type["title-2"].size, fontWeight: "700" }}>
          {name}
        </Text>
        {row.commonName ? <Text style={{ color: colors.muted, fontSize: type.body.size, fontStyle: "italic" }}>{row.scientificName}</Text> : null}
      </View>
      <View style={{ borderRadius: radius.panel, padding: 16, backgroundColor: colors.accentTint, flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }} accessible accessibilityLabel={t(verdictKey(row), { n: row.photos })}>
          <Text style={{ color: colors.link, fontSize: type.headline.size, fontWeight: "700" }}>{t(VERDICT_TITLE[row.status])}</Text>
          <Text style={{ color: colors.ink, fontSize: type.subheadline.size }}>{t(VERDICT_LINE[row.status], { n: row.photos })}</Text>
        </View>
        {row.coverPhotoId ? <CachedTile photoId={row.coverPhotoId} size={64} width={64} rounded label={t("identify.bestPhoto")} /> : null}
      </View>
      <View style={{ gap: 10 }}>
        {row.status === "none" ? <Button label={t("species.markSeen")} icon="seen" onPress={() => void markSeen()} /> : null}
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Button
            variant={row.status === "none" ? "secondary" : "primary"}
            label={t(row.isTarget ? "species.unmarkTarget" : "species.markTarget")}
            icon="target"
            onPress={() => void toggleTarget()}
            grow={1}
          />
          <Button
            variant="secondary"
            label={t("identify.openSpecies")}
            onPress={() => {
              nav.goBack();
              setTimeout(() => nav.navigate("Species", { scientificName: row.scientificName }), 350);
            }}
            grow={1}
          />
        </View>
      </View>
      <Button variant="plain" label={t("identify.changeSpecies")} onPress={() => nav.goBack()} />
    </Screen>
  );
}
