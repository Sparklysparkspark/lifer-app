import { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { NAME_MAX_LENGTH } from "@lifer/shared";
import { newLocalId } from "../app/actions";
import { useApp, useLocal } from "../app/AppContext";
import { useSheetHeader } from "../navigation/useHeader";
import { useNav } from "../navigation/types";
import { startLocalTrip } from "../store/library";
import { listRegions } from "../store/regions";
import { Button, GroupHeader, InsetGroup, ListRow, Screen, TextField } from "../ui";

const today = () => new Date().toISOString().slice(0, 10);

/** Start a trip: a name and the region whose list it follows. Starting one turns on trip mode. */
export function StartTripSheet() {
  const { t } = useTranslation();
  const app = useApp();
  const nav = useNav();
  const [name, setName] = useState("");
  const [region, setRegion] = useState<string | null>(null);
  const { data } = useLocal(listRegions);
  useSheetHeader();

  async function start() {
    const id = newLocalId();
    await startLocalTrip(app.db, id, name.trim() || t("trips.defaultName", { date: today() }), region, today());
    app.bump();
    nav.goBack();
    setTimeout(() => nav.navigate("Trip", { id }), 350);
  }

  return (
    <Screen padded={false}>
      <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
        <TextField label={t("trips.nameLabel")} value={name} onChangeText={setName} autoCapitalize="words" maxLength={NAME_MAX_LENGTH} />
      </View>
      {data && data.length > 0 ? (
        <>
          <GroupHeader text={t("trips.pickRegion")} />
          <InsetGroup>
            <ListRow title={t("trips.noRegion")} selected={region === null} onPress={() => setRegion(null)} />
            {data.map((r) => (
              <ListRow key={r.key} title={r.name} value={t("regions.speciesCount", { n: r.speciesCount })} selected={region === (r.hubRegionId ?? r.key)} onPress={() => setRegion(r.hubRegionId ?? r.key)} />
            ))}
          </InsetGroup>
        </>
      ) : null}
      <View style={{ padding: 20 }}>
        <Button label={t("trips.start")} icon="trips" onPress={() => void start()} />
      </View>
    </Screen>
  );
}
