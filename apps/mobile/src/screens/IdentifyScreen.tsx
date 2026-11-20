import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, useLocal } from "../app/AppContext";
import { useHeader } from "../navigation/useHeader";
import { useTabClearance } from "../navigation/clearance";
import { useNav } from "../navigation/types";
import { matchSpecies } from "../search/species";
import { allSpecies, type SpeciesRow } from "../store/marks";
import { getMeta, setMeta } from "../store/meta";
import { groupOf } from "../theme/groups";
import { radius, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Button, EmptyState, GroupHeader, Icon, InlineError, InsetGroup, ListRow, Note, type IconName } from "../ui";

export interface Recent {
  scientificName: string;
  photoUri: string | null;
}
const RECENT_KEY = "identifyRecent";
const KEEP = 8;

/** What a species means for this person: a lifer, or one they already have. */
export function verdictKey(row: Pick<SpeciesRow, "status" | "photos">): string {
  if (row.status === "none") return "identify.verdictNew";
  return row.status === "seen" ? "identify.verdictSeen" : "identify.verdictPhotographed";
}

/** The short verdict for a row ("Seen, no photo yet"). */
export function verdictShort(row: Pick<SpeciesRow, "status" | "photos">): string {
  if (row.status === "none") return "identify.shortNew";
  return row.status === "seen" ? "identify.shortSeen" : "identify.shortPhotographed";
}

/** Remembers a check at the top of the recent list. */
export async function rememberCheck(db: Parameters<typeof setMeta>[0], r: Recent): Promise<void> {
  const list = (await getMeta<Recent[]>(db, RECENT_KEY)) ?? [];
  await setMeta(db, RECENT_KEY, [r, ...list.filter((x) => x.scientificName !== r.scientificName)].slice(0, KEEP));
}

/**
 * "Is this a lifer?": pick a photo or type a name. There is no recognition model on the phone yet, so
 * the photo is only shown for reference and the name does the finding.
 */
export function IdentifyScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const nav = useNav();
  const app = useApp();
  const insets = useSafeAreaInsets();
  const clearance = useTabClearance();
  const [photo, setPhoto] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const deferred = useDeferredValue(query);
  const { data: all } = useLocal(allSpecies);
  const { data: recent } = useLocal((db) => getMeta<Recent[]>(db, RECENT_KEY), [app.version]);
  useHeader({
    title: t("tabs.identify"),
    search: { placeholder: t("identify.typeLabel"), onChange: setQuery, hideWhenScrolling: false },
  });

  const matches = useMemo(
    () => (all && deferred.trim() ? matchSpecies(all, deferred).slice(0, 8) : []),
    [all, deferred],
  );
  const searching = deferred.trim().length > 0;
  const bySci = useMemo(() => new Map((all ?? []).map((s) => [s.scientificName, s])), [all]);
  const checks = (recent ?? []).filter((r) => bySci.has(r.scientificName));

  // A pick from the list or from a recent check opens the verdict over the photo.
  const check = (scientificName: string, uri: string | null = photo) =>
    nav.navigate("IdentifyResult", { photoUri: uri, scientificName });

  async function choosePhoto(camera: boolean) {
    setError(null);
    try {
      // The system picker needs no photo library permission; the camera is asked for now, when it is used (MR10, MR11).
      const res = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.5 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.5 });
      if (!res.canceled && res.assets[0]) setPhoto(res.assets[0].uri);
    } catch {
      setError(t("identify.cameraFailed"));
    }
  }
  useEffect(() => void setError(null), [photo]);

  const row = (s: SpeciesRow, uri: string | null) => (
    <ListRow
      key={s.scientificName}
      title={s.commonName ?? s.scientificName}
      subtitle={t(verdictShort(s))}
      leadingSize={52}
      leading={
        uri ? (
          <Image
            source={{ uri }}
            style={{ width: 52, height: 52, borderRadius: 10 }}
            contentFit="cover"
            transition={0}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: 10,
              backgroundColor: colors.placeholder,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon
              name={groupOf(s.taxonClass).id as IconName}
              size={26}
              color={colors[groupOf(s.taxonClass).color]}
              weight="regular"
            />
          </View>
        )
      }
      onPress={() => check(s.scientificName, uri)}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, clearance) + 190 }}
      >
        <Text
          style={{
            color: colors.muted,
            fontSize: type.body.size,
            paddingHorizontal: 20,
            paddingTop: 6,
            paddingBottom: 12,
          }}
        >
          {t("identify.lead")}
        </Text>
        {app.mode === "standalone" ? (
          <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
            <Note text={t("identify.smartNote")} />
          </View>
        ) : null}
        {photo ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <Image
              accessibilityLabel={t("identify.photoLabel")}
              source={{ uri: photo }}
              contentFit="cover"
              style={{ height: 300, borderRadius: radius.group, backgroundColor: colors.placeholder }}
              accessibilityIgnoresInvertColors
            />
          </View>
        ) : null}
        {error ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
            <InlineError message={error} />
          </View>
        ) : null}
        {searching ? (
          matches.length > 0 ? (
            <InsetGroup>
              {matches.map((m) => (
                <ListRow
                  key={m.scientificName}
                  title={m.commonName ?? m.scientificName}
                  subtitle={`${t(verdictShort(m))}${m.commonName ? `. ${m.scientificName}` : ""}`}
                  onPress={() => check(m.scientificName)}
                />
              ))}
            </InsetGroup>
          ) : all ? (
            <View style={{ paddingHorizontal: 20 }}>
              <Note text={t("identify.noMatch")} />
            </View>
          ) : null
        ) : checks.length > 0 ? (
          <>
            <GroupHeader text={t("identify.recent")} />
            <InsetGroup>{checks.map((r) => row(bySci.get(r.scientificName)!, r.photoUri))}</InsetGroup>
          </>
        ) : !photo ? (
          <EmptyState icon="identify" title={t("identify.emptyTitle")} line={t("identify.emptyLine")} />
        ) : null}
      </ScrollView>
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", left: 16, right: 16, bottom: Math.max(insets.bottom, clearance) + 8 }}
      >
        <Text
          style={{
            color: colors.muted,
            fontSize: type.footnote.size,
            textAlign: "center",
            paddingHorizontal: 12,
            paddingBottom: 12,
          }}
        >
          {t("identify.noModelNote")}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Button
            label={t(photo ? "identify.chooseAnother" : "identify.choose")}
            icon="choosePhoto"
            onPress={() => void choosePhoto(false)}
            grow={1}
          />
          <Button
            variant="secondary"
            label={t("identify.take")}
            icon="camera"
            onPress={() => void choosePhoto(true)}
            grow={1}
          />
        </View>
      </View>
    </View>
  );
}
