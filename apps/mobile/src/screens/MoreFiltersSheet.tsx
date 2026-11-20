import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { TIER_ORDER } from "@lifer/shared";
import { useLocal } from "../app/AppContext";
import { activeFilterCount, useCollectionView } from "../collection/view";
import { useSheetHeader } from "../navigation/useHeader";
import { photoYears } from "../store/browse";
import { Button, GroupFooter, GroupHeader, InsetGroup, ListRow, Screen, SwitchRow } from "../ui";
import { TIER_LABEL } from "../labels";

/** The filters that need more than a checkmark: rarity, vagrants, and the year a species was photographed. */
export function MoreFiltersSheet() {
  const { t } = useTranslation();
  const { view, update, clearFilters } = useCollectionView();
  const { data: years } = useLocal(photoYears);
  useSheetHeader();
  const toggle = (tier: string, on: boolean) =>
    update({ tiers: on ? [...view.tiers, tier] : view.tiers.filter((x) => x !== tier) });
  return (
    <Screen padded={false}>
      <GroupHeader text={t("filters.rarity")} />
      <InsetGroup>
        {TIER_ORDER.map((tier) => (
          <SwitchRow
            key={tier}
            label={t(TIER_LABEL[tier])}
            value={view.tiers.includes(tier)}
            onChange={(on) => toggle(tier, on)}
          />
        ))}
      </InsetGroup>
      <GroupFooter text={t("filters.rarityNote")} />
      <GroupHeader text={t("filters.traits")} />
      <InsetGroup>
        <SwitchRow
          label={t("filters.vagrants")}
          hint={t("filters.vagrantsHint")}
          value={view.vagrants}
          onChange={(vagrants) => update({ vagrants })}
        />
      </InsetGroup>
      {years && years.length > 0 ? (
        <>
          <GroupHeader text={t("filters.year")} />
          <InsetGroup>
            <ListRow
              title={t("filters.anyYear")}
              selected={view.year === null}
              onPress={() => update({ year: null })}
            />
            {years.map((y) => (
              <ListRow key={y} title={y} selected={view.year === y} onPress={() => update({ year: y })} />
            ))}
          </InsetGroup>
        </>
      ) : null}
      {activeFilterCount(view) > 0 ? (
        <View style={{ padding: 20 }}>
          <Button variant="secondary" label={t("collection.clearFilters")} onPress={clearFilters} />
        </View>
      ) : null}
    </Screen>
  );
}
