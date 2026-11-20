import { Alert, View } from "react-native";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useApp, useLocal, useSmartStatus } from "../app/AppContext";
import { hubLabelKey } from "../connection/pair";
import { syncLine } from "../format/format";
import { sizeText } from "../format/sizeText";
import { usage } from "../media/cache";
import type { SmartStatus } from "../search/smartSearch";
import { photoCount } from "../store/library";
import { useNav } from "../navigation/types";
import { THUMB_CAPS, type AppearancePref } from "../store/settings";
import { GroupFooter, GroupHeader, InsetGroup, ListRow, Screen, SwitchRow } from "../ui";
import { NAME_ORDER_LABEL } from "../labels";

const APPEARANCES: { id: AppearancePref; label: string }[] = [
  { id: "system", label: "settings.appearanceSystem" },
  { id: "light", label: "settings.appearanceLight" },
  { id: "dark", label: "settings.appearanceDark" },
  { id: "sunlight", label: "settings.appearanceSunlight" },
];

/** One plain line for what smart search offline is doing. */
function smartLine(t: TFunction, s: SmartStatus, size: string): string {
  const percent = s.total > 0 ? Math.floor((100 * s.done) / s.total) : 0;
  switch (s.phase) {
    case "ready":
      return t("settings.smartReady", { size });
    case "downloading":
      return t("settings.smartDownloading", { percent });
    case "syncing":
      return t("settings.smartSyncing", { count: s.done });
    case "waiting":
      return t("settings.smartWaiting");
    case "unavailable":
      return t("settings.smartUnavailable");
    case "error":
      return t("settings.smartError");
    case "off":
      return t("settings.smartOff");
    default:
      return t("settings.smartIdle");
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Settings as a native grouped list: label left, control right. Technical words stay under Connection, Advanced. */
export function SettingsScreen() {
  const { t } = useTranslation();
  const app = useApp();
  const nav = useNav();
  const smart = useSmartStatus();
  const { data } = useLocal(async (db) => ({
    usage: await usage(db),
    showcase: await app.media.showcaseStatus(),
    photos: await photoCount(db),
  }));
  const bytes = (n: number) => sizeText(t, n);
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

  const confirmDisconnect = () =>
    Alert.alert(t("pair.disconnectTitle", { hub }), t("pair.disconnectMessage"), [
      { text: t("pair.cancel"), style: "cancel" },
      { text: t("pair.disconnectConfirm"), style: "destructive", onPress: () => void app.disconnect() },
    ]);
  const confirmClear = (what: "thumbs" | "showcase") =>
    Alert.alert(
      t(what === "thumbs" ? "settings.clearCacheTitle" : "settings.clearShowcaseTitle"),
      t("settings.clearBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("settings.clear"), style: "destructive", onPress: () => void app.media.clear(what).then(app.bump) },
      ],
    );

  const confirmRemoveSmart = () =>
    Alert.alert(t("settings.smartRemoveTitle"), t("settings.smartRemoveBody"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("settings.smartRemoveConfirm"),
        style: "destructive",
        onPress: () =>
          void app
            .updateSettings({ smartSearch: false })
            .then(() => app.smart.remove())
            .then(app.bump),
      },
    ]);
  const startSmart = () =>
    void app
      .updateSettings({ smartSearch: true })
      .then(() => app.smart.refresh())
      .then(app.bump);
  const smartKept = smart.modelBytes > 0 || smart.vectors > 0;

  return (
    <Screen padded={false}>
      <GroupHeader text={t("settings.connection")} />
      <InsetGroup>
        {app.paired ? (
          <>
            <ListRow
              title={t("pair.connected", { hub })}
              subtitle={app.sync.keyRefused ? t("sync.keyRefused") : app.mode === "paired" ? t(key, values) : undefined}
              chevron={false}
            />
            <ListRow
              title={t("settings.syncNow")}
              onPress={() => void app.sync.run()}
              chevron={false}
              hint={app.sync.syncing ? t("sync.syncing") : undefined}
            />
            <ListRow title={t("pair.disconnect")} destructive onPress={confirmDisconnect} chevron={false} />
          </>
        ) : (
          <>
            <ListRow title={t("settings.notConnected")} chevron={false} />
            <ListRow title={t("welcome.connect")} onPress={() => nav.navigate("Connect")} />
          </>
        )}
      </InsetGroup>
      {app.paired ? (
        <>
          <GroupHeader text={t("settings.advanced")} />
          <InsetGroup>
            <ListRow title={t("settings.address")} value={hostOf(app.paired.hub.baseUrl)} />
            <ListRow title={t("settings.fingerprint")} value={`${(app.paired.hub.certSha256 ?? "").slice(0, 16)}...`} />
          </InsetGroup>
        </>
      ) : null}

      <GroupHeader text={t("settings.appearance")} />
      <InsetGroup>
        {APPEARANCES.map((a) => (
          <ListRow
            key={a.id}
            title={t(a.label)}
            selected={app.settings.appearance === a.id}
            onPress={() => void app.updateSettings({ appearance: a.id })}
          />
        ))}
      </InsetGroup>

      <GroupHeader text={t("settings.names")} />
      <InsetGroup>
        {(["common", "scientific"] as const).map((o) => (
          <ListRow
            key={o}
            title={t(NAME_ORDER_LABEL[o])}
            selected={app.settings.nameOrder === o}
            onPress={() => void app.updateSettings({ nameOrder: o })}
          />
        ))}
      </InsetGroup>

      {app.paired || smartKept ? (
        <>
          <GroupHeader text={t("settings.smartSearch")} />
          <InsetGroup>
            <ListRow
              title={t("settings.smartSearch")}
              subtitle={smartLine(t, smart, bytes(smart.modelBytes + (smart.vectors + smart.backgrounds) * 1536))}
              chevron={false}
            />
            {app.settings.smartSearch ? (
              <ListRow title={t("settings.smartRemove")} destructive onPress={confirmRemoveSmart} chevron={false} />
            ) : app.paired ? (
              <ListRow title={t("settings.smartDownload")} onPress={startSmart} chevron={false} />
            ) : null}
          </InsetGroup>
        </>
      ) : (data?.photos ?? 0) > 0 ? (
        <>
          <GroupHeader text={t("settings.smartSearch")} />
          <InsetGroup>
            <ListRow title={t("settings.smartSearch")} subtitle={t("settings.smartPhoneOnly")} chevron={false} />
          </InsetGroup>
        </>
      ) : null}

      <GroupHeader text={t("settings.photosOnPhone")} />
      <InsetGroup>
        <ListRow
          title={t("settings.photoCache")}
          subtitle={t("settings.cacheUsed", { used: bytes(data?.usage.thumb ?? 0) })}
          value={bytes(app.settings.thumbCapBytes)}
          chevron={false}
        />
        <ListRow title={t("settings.clearCache")} destructive onPress={() => confirmClear("thumbs")} chevron={false} />
        <SwitchRow
          label={t("settings.wifiOnly")}
          hint={t("settings.wifiOnlyHint")}
          value={app.settings.wifiOnly}
          onChange={(v) => void app.updateSettings({ wifiOnly: v })}
        />
      </InsetGroup>
      <GroupHeader text={t("settings.cacheSize")} />
      <InsetGroup>
        {THUMB_CAPS.map((c) => (
          <ListRow
            key={c}
            title={bytes(c)}
            selected={app.settings.thumbCapBytes === c}
            onPress={() => void app.updateSettings({ thumbCapBytes: c })}
          />
        ))}
      </InsetGroup>

      <GroupHeader text={t("settings.showcase")} />
      <InsetGroup>
        <ListRow
          title={t("settings.showcase")}
          subtitle={t("settings.showcaseUsed", {
            used: bytes(data?.usage.phone ?? 0),
            count: data?.showcase.missing ?? 0,
          })}
          chevron={false}
        />
        <SwitchRow
          label={t("settings.showcaseFavourites")}
          value={app.settings.showcaseFavouritesOnly}
          onChange={(v) => void app.updateSettings({ showcaseFavouritesOnly: v }).then(app.bump)}
        />
        <ListRow
          title={t("settings.clearShowcase")}
          destructive
          onPress={() => confirmClear("showcase")}
          chevron={false}
        />
      </InsetGroup>
      <GroupFooter text={t("settings.showcaseHint")} />

      <GroupHeader text={t("settings.about")} />
      <View>
        <GroupFooter text={t("settings.privacy")} />
      </View>
    </Screen>
  );
}
