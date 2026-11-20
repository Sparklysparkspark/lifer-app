import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp, useLocal } from "../app/AppContext";
import { hubLabelKey } from "../connection/pair";
import { syncLine } from "../format/format";
import { sizeText } from "../format/sizeText";
import { usage } from "../media/cache";
import { useSyncProgress } from "../sync/progress";
import { listRegions } from "../store/regions";
import { useSheetHeader } from "../navigation/useHeader";
import { useNav } from "../navigation/types";
import { ON_BACKDROP } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { GroupFooter, Icon, InsetGroup, ListRow, Screen, type IconName } from "../ui";

function Tile({ icon, color }: { icon: IconName; color: string }) {
  return (
    <View
      style={{
        width: 30,
        height: 30,
        borderRadius: 8,
        backgroundColor: color,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={icon} size={17} color={ON_BACKDROP} weight="semibold" />
    </View>
  );
}

/** "Your Lifer": how the phone stands with the Lifer in plain words, and the pages the tab bar has no room for. */
export function YourLiferSheet() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const app = useApp();
  const progress = useSyncProgress();
  const nav = useNav();
  useSheetHeader();
  const { data } = useLocal(async (db) => ({
    used: (await usage(db)).thumb + (await usage(db)).phone,
    regions: (await listRegions(db)).length,
  }));

  const hub = app.paired ? t(hubLabelKey(app.paired.hub.kind)) : "";
  const line = syncLine({
    syncing: app.sync.syncing,
    lastSyncAt: app.sync.lastSyncAt,
    waiting: app.sync.waiting,
    now: new Date(),
    reachable: app.sync.reachable,
    desktop: app.paired?.hub.kind === "desktop",
  });
  const { key, ...values } = line;
  const ago = t(key, values);

  const go = (to: () => void) => () => {
    nav.goBack();
    setTimeout(to, 350);
  };

  let title: string;
  let subtitle: string;
  let action: { label: string; onPress: () => void } | null = null;
  if (app.mode === "standalone") {
    title = t("account.standaloneTitle");
    subtitle = t("account.standaloneLine");
    action = { label: t("account.connect"), onPress: go(() => nav.navigate("Connect")) };
  } else if (app.sync.keyRefused) {
    title = t("account.refusedTitle");
    subtitle = t("sync.keyRefused");
    action = { label: t("account.connectAgain"), onPress: go(() => nav.navigate("Connect")) };
  } else if (app.sync.syncing) {
    title = t("sync.syncing");
    subtitle = progress ? t("account.progress", { n: progress }) : t("account.syncingLine");
  } else if (!app.sync.reachable) {
    title = t("account.offlineTitle");
    subtitle = app.sync.waiting > 0 ? ago : t("account.offlineLine", { hub });
    action = { label: t("settings.syncNow"), onPress: () => void app.sync.run() };
  } else {
    title = t("account.upToDate");
    subtitle = t("account.syncedWith", { hub, ago });
    action = { label: t("settings.syncNow"), onPress: () => void app.sync.run() };
  }

  return (
    <Screen padded={false}>
      <View style={{ paddingTop: 8 }}>
        <InsetGroup>
          <ListRow
            title={title}
            subtitle={subtitle}
            bold
            leadingSize={40}
            leading={
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 11,
                  backgroundColor: app.sync.reachable || app.mode === "standalone" ? colors.accent : colors.muted,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon
                  name={app.mode === "standalone" || app.sync.reachable ? "sync" : "offline"}
                  size={20}
                  color={colors["accent-fg"]}
                  weight="semibold"
                />
              </View>
            }
          />
          {action ? <ListRow title={action.label} link chevron={false} onPress={action.onPress} /> : null}
        </InsetGroup>
      </View>
      <View style={{ paddingTop: 16 }}>
        <InsetGroup>
          <ListRow
            title={t("stats.title")}
            leadingSize={30}
            leading={<Tile icon="stats" color={colors["taxa-fish"]} />}
            onPress={go(() => nav.navigate("Stats"))}
          />
          <ListRow
            title={t("regions.title")}
            value={t("account.regionsOnPhone", { n: data?.regions ?? 0 })}
            leadingSize={30}
            leading={<Tile icon="regions" color={colors["taxa-birds"]} />}
            onPress={go(() => nav.navigate("Regions"))}
          />
          <ListRow
            title={t("settings.title")}
            leadingSize={30}
            leading={<Tile icon="settings" color={colors.muted} />}
            onPress={go(() => nav.navigate("Settings"))}
          />
        </InsetGroup>
      </View>
      <GroupFooter text={t("account.storage", { size: sizeText(t, data?.used ?? 0) })} />
    </Screen>
  );
}
