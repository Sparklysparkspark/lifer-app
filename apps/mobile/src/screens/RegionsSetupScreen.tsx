import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp } from "../app/AppContext";
import { sizeText } from "../format/sizeText";
import { countryAt, currentPosition } from "../location/position";
import { fetchPackIndex } from "../standalone/indexFile";
import { listPackRegions, packChecklist, regionForCountry, type PackIndex } from "../standalone/packs";
import { setMeta } from "../store/meta";
import { BYTES_PER_SPECIES, regionKeyForPack, saveRegion } from "../store/regions";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Body, Button, GroupFooter, InlineError, InsetGroup, ListRow, Note, Screen, Spinner, TextField } from "../ui";

export const REGIONS_SETUP_KEY = "regionsSetup";

/** First run on the phone alone: which regions' species lists to keep. Location is asked only for the suggestion, when tapped. */
export function RegionsSetupScreen({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const app = useApp();
  const [index, setIndex] = useState<PackIndex | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState<"index" | "locate" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const regions = useMemo(() => (index ? listPackRegions(index) : []), [index]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return regions.filter((r) => r.name.toLowerCase().includes(q));
  }, [regions, query]);
  const size = (n: number) => `${t("regions.speciesCount", { n })}, ${t("regions.about", { size: sizeText(t, n * BYTES_PER_SPECIES) })}`;
  const toggle = (name: string) => setChosen((c) => (c.includes(name) ? c.filter((x) => x !== name) : [...c, name]));

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

  async function suggest() {
    setBusy("locate");
    const fix = await currentPosition(true);
    const match = fix.status === "ok" ? regionForCountry(regions, await countryAt(fix.position)) : null;
    setSuggested(match?.name ?? "");
    if (match) setChosen((c) => (c.includes(match.name) ? c : [match.name, ...c]));
    setBusy(null);
  }

  async function finish(download: boolean) {
    setBusy("save");
    if (download && index)
      for (const name of chosen) await saveRegion(app.db, { key: regionKeyForPack(name), name, source: "pack", hubRegionId: null }, packChecklist(index, name), new Date());
    await setMeta(app.db, REGIONS_SETUP_KEY, true);
    app.bump();
    onDone();
  }

  return (
    <Screen safeTop padded={false}>
      <View style={{ paddingHorizontal: 24, paddingTop: 16, gap: 12 }}>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type["large-title"].size, fontWeight: "700" }}>
          {t("regionsSetup.title")}
        </Text>
        <Body text={t("regionsSetup.body")} />
        {error ? <InlineError message={error} retry={{ label: t("pair.tryAgain"), onPress: () => void getList() }} /> : null}
      </View>
      {!index ? (
        <View style={{ padding: 24, gap: 16 }}>
          <Body text={t("regions.getListHint")} />
          {busy === "index" ? <Spinner label={t("regions.downloading")} /> : <Button label={t("regions.getList")} icon="regions" onPress={() => void getList()} />}
        </View>
      ) : (
        <>
          <View style={{ paddingHorizontal: 20, paddingTop: 16, gap: 8 }}>
            {suggested === null ? (
              <>
                <Button variant="secondary" label={t("regionsSetup.suggest")} icon="regions" onPress={() => void suggest()} disabled={busy === "locate"} />
                <Note text={t("regionsSetup.locationWhy")} />
              </>
            ) : suggested === "" ? (
              <Note text={t("regionsSetup.noSuggestion")} />
            ) : (
              <Note text={t("regionsSetup.suggested", { name: suggested })} />
            )}
            <TextField label={t("regions.searchLabel")} value={query} onChangeText={setQuery} autoCapitalize="none" returnKeyType="search" />
          </View>
          <View style={{ paddingTop: 12 }}>
            <InsetGroup>
              {shown.slice(0, 80).map((r) => (
                <ListRow key={r.name} title={r.name} subtitle={size(r.speciesCount)} selected={chosen.includes(r.name)} chevron={false} onPress={() => toggle(r.name)} />
              ))}
            </InsetGroup>
            {shown.length > 80 ? <GroupFooter text={t("regions.searchToNarrow", { n: shown.length })} /> : null}
          </View>
        </>
      )}
      <View style={{ paddingHorizontal: 16, paddingTop: 16, gap: 10 }}>
        {index ? (
          busy === "save" ? (
            <Spinner label={t("regions.downloading")} />
          ) : (
            <Button label={t("regionsSetup.keep", { n: chosen.length })} disabled={chosen.length === 0} onPress={() => void finish(true)} />
          )
        ) : null}
        <Button variant="plain" label={t("regionsSetup.skip")} onPress={() => void finish(false)} disabled={busy === "save"} />
        <Text style={{ color: colors.muted, fontSize: type.footnote.size, textAlign: "center" }}>{t("regionsSetup.later")}</Text>
      </View>
    </Screen>
  );
}
