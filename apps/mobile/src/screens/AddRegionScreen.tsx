import { useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp, useLocal } from "../app/AppContext";
import { sizeText } from "../format/sizeText";
import { useSheetHeader } from "../navigation/useHeader";
import { fetchPackIndex } from "../standalone/indexFile";
import { listPackRegions, packChecklist, type PackIndex } from "../standalone/packs";
import { getMeta } from "../store/meta";
import { BYTES_PER_SPECIES, listRegions, regionKeyForHub, regionKeyForPack, saveRegion } from "../store/regions";
import type { Preferences } from "../sync/engine";
import { Body, Button, GroupFooter, InlineError, InsetGroup, ListRow, Note, Screen, Spinner, TextField } from "../ui";

interface Checklist {
  regionId: string;
  name: string;
  items: {
    scientificName: string;
    commonName: string | null;
    taxonClass: string;
    tier: string | null;
    isVagrant: boolean;
    sensitiveByDefault: boolean;
  }[];
}

/** Keep another region's species list on the phone. The size is shown before anything is downloaded. */
export function AddRegionScreen() {
  const { t } = useTranslation();
  const app = useApp();
  const [index, setIndex] = useState<PackIndex | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useSheetHeader();
  const { data } = useLocal(async (db) => ({
    kept: await listRegions(db),
    prefs: await getMeta<Preferences>(db, "prefs"),
  }));
  const keptKeys = new Set(data?.kept.map((r) => r.key));

  const size = (n: number) =>
    `${t("regions.speciesCount", { n })}, ${t("regions.about", { size: sizeText(t, n * BYTES_PER_SPECIES) })}`;

  async function keepHub(regionId: string) {
    setBusy(regionId);
    setError(null);
    try {
      const list = await app.api!.get<Checklist>(`/sync/regions/${regionId}/checklist`);
      await saveRegion(
        app.db,
        { key: regionKeyForHub(regionId), name: list.name, source: "hub", hubRegionId: regionId },
        list.items.map((i) => ({
          scientificName: i.scientificName,
          commonName: i.commonName,
          taxonClass: i.taxonClass,
          tier: i.tier,
          vagrant: i.isVagrant,
          sensitive: i.sensitiveByDefault,
        })),
        new Date(),
      );
      app.bump();
    } catch {
      setError(t("regions.failed"));
    } finally {
      setBusy(null);
    }
  }

  async function keepPack(name: string) {
    if (!index) return;
    setBusy(name);
    await saveRegion(
      app.db,
      { key: regionKeyForPack(name), name, source: "pack", hubRegionId: null },
      packChecklist(index, name),
      new Date(),
    );
    app.bump();
    setBusy(null);
  }

  async function getList() {
    setBusy("index");
    setError(null);
    try {
      setIndex(await fetchPackIndex());
    } catch {
      setError(t("regions.failed"));
    } finally {
      setBusy(null);
    }
  }

  const packRegions = useMemo(() => {
    if (!index) return [];
    const q = query.trim().toLowerCase();
    return listPackRegions(index).filter(
      (r) => !keptKeys.has(regionKeyForPack(r.name)) && r.name.toLowerCase().includes(q),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, query, data]);

  const hubRegions = (data?.prefs?.regions ?? []).filter(
    (r) => r.regionId && !keptKeys.has(regionKeyForHub(r.regionId)),
  );
  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: 20, paddingTop: 8, gap: 12 }}>
        {error ? (
          <InlineError
            message={error}
            retry={app.mode === "paired" ? undefined : { label: t("pair.tryAgain"), onPress: () => void getList() }}
          />
        ) : null}
        {app.mode === "paired" ? <Note text={t("regions.fromHub")} /> : null}
      </View>
      {app.mode === "paired" ? (
        hubRegions.length > 0 ? (
          <View style={{ paddingTop: 12 }}>
            <InsetGroup>
              {hubRegions.map((r) => (
                <ListRow
                  key={r.regionId!}
                  title={r.name}
                  subtitle={size(r.speciesCount)}
                  value={busy === r.regionId ? t("regions.downloading") : t("regions.keep")}
                  chevron={false}
                  onPress={() => void keepHub(r.regionId!)}
                />
              ))}
            </InsetGroup>
          </View>
        ) : (
          <View style={{ padding: 20 }}>
            <Note text={t("regions.hubNothing")} />
          </View>
        )
      ) : !index ? (
        <View style={{ padding: 20, gap: 16 }}>
          <Body text={t("regions.getListHint")} />
          {busy === "index" ? (
            <Spinner label={t("regions.downloading")} />
          ) : (
            <Button label={t("regions.getList")} icon="regions" onPress={() => void getList()} />
          )}
        </View>
      ) : (
        <>
          <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
            <TextField
              label={t("regions.searchLabel")}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              returnKeyType="search"
            />
          </View>
          <View style={{ paddingTop: 12 }}>
            <InsetGroup>
              {packRegions.slice(0, 80).map((r) => (
                <ListRow
                  key={r.name}
                  title={r.name}
                  subtitle={size(r.speciesCount)}
                  value={busy === r.name ? t("regions.downloading") : t("regions.keep")}
                  chevron={false}
                  onPress={() => void keepPack(r.name)}
                />
              ))}
            </InsetGroup>
            {packRegions.length > 80 ? (
              <GroupFooter text={t("regions.searchToNarrow", { n: packRegions.length })} />
            ) : null}
          </View>
        </>
      )}
    </Screen>
  );
}
