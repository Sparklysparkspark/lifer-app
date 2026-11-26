import { useState } from "react";
import { Share, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp, useLocal } from "../app/AppContext";
import { useCollectionView } from "../collection/view";
import { useHeader } from "../navigation/useHeader";
import { useNav, type RootParams } from "../navigation/types";
import { HeroPager } from "../photos/HeroPager";
import { PhotoGrid } from "../photos/PhotoGrid";
import { referenceId, useReferenceCredit } from "../photos/reference";
import { regionTier, speciesFacts } from "../store/browse";
import { speciesPhotos, type PhotoSort } from "../store/library";
import { getMark, getSpecies } from "../store/marks";
import { listRegions } from "../store/regions";
import { groupOf } from "../theme/groups";
import { radius, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import {
  Button,
  FloatingToolbar,
  Icon,
  InsetGroup,
  ListRow,
  Note,
  RoundButton,
  Tap,
  showActions,
  type IconName,
} from "../ui";
import { dateText } from "../format/dates";
import { useSpeciesActions } from "./parts/useSpeciesActions";
import { tierPills } from "../collection/tiers";
import { TierLabel } from "../ui/TierLabel";

const HERO = 340;
const SORTS: PhotoSort[] = ["best", "newest", "oldest"];
const SORT_LABEL: Record<PhotoSort, string> = {
  best: "species.sortBest",
  newest: "species.sortNewest",
  oldest: "species.sortOldest",
};

/** A status toggle: Seen or Target. Two equal buttons, never a sentence. */
function Toggle({
  label,
  icon,
  on,
  onPress,
  status,
}: {
  label: string;
  icon: IconName;
  on: boolean;
  onPress?: () => void;
  status?: boolean;
}) {
  const { colors } = useTheme();
  const body = (
    <View
      style={{
        minHeight: 46,
        borderRadius: radius.control,
        paddingHorizontal: 12,
        paddingVertical: 8,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        backgroundColor: on ? colors.accentTint : colors.fill,
      }}
    >
      <Icon name={icon} size={20} color={on ? colors.link : colors.ink} weight="semibold" />
      <Text
        style={{ color: on ? colors.link : colors.ink, fontSize: type.headline.size, fontWeight: "600", flexShrink: 1 }}
      >
        {label}
      </Text>
    </View>
  );
  if (status)
    return (
      <View accessible accessibilityLabel={label} style={{ flex: 1 }}>
        {body}
      </View>
    );
  return (
    <Tap label={label} role="switch" checked={on} onPress={onPress} style={{ flex: 1 }}>
      {body}
    </Tap>
  );
}

/** A species: its photos, status as two toggles, facts, and and Share. */
export function SpeciesScreen({ route }: { route: { params: RootParams["Species"] } }) {
  const { scientificName } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const nav = useNav();
  const app = useApp();
  const { view } = useCollectionView();
  const [sort, setSort] = useState<PhotoSort>("best");
  const actions = useSpeciesActions();
  const { data } = useLocal(
    async (db) => ({
      species: await getSpecies(db, scientificName),
      mark: await getMark(db, scientificName),
      // The hero takes the best few whatever the grid is sorted by.
      photos: await speciesPhotos(db, scientificName, "best", 6),
      all: await speciesPhotos(db, scientificName, sort),
      facts: await speciesFacts(db, scientificName),
      regions: await listRegions(db),
      localTier: view.region ? await regionTier(db, view.region, scientificName) : null,
    }),
    [scientificName, sort, view.region],
  );
  const species = data?.species ?? null;
  const target = {
    scientificName,
    commonName: species?.commonName ?? null,
    status: species?.status ?? ("none" as const),
    isTarget: !!data?.mark?.isTarget,
  };
  const name = species?.commonName ?? scientificName;
  const noOwnPhotos = !!data && data.all.length === 0;
  const credit = useReferenceCredit(scientificName, noOwnPhotos);

  useHeader({
    noAccount: true,
    options: {
      title: "",
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      headerLargeStyle: { backgroundColor: "transparent" },
      scrollEdgeEffects: { top: "hidden" },
    },
    items: [
      {
        type: "menu",
        key: "more",
        label: t("common.more"),
        icon: "more",
        items: [
          {
            type: "action",
            label: t("species.openInCollection"),
            icon: "collection",
            onPress: () => nav.navigate("Tabs", { screen: "Collection" }),
          },
          ...(target.status === "photographed"
            ? []
            : [
                {
                  type: "action",
                  label: t(target.status === "seen" ? "species.unmarkSeen" : "species.markSeen"),
                  icon: "seen",
                  onPress: () => void actions.toggleSeen(target),
                } as const,
              ]),
          {
            type: "action",
            label: t(target.isTarget ? "species.unmarkTarget" : "species.markTarget"),
            icon: "target",
            onPress: () => void actions.toggleTarget(target),
          },
          {
            type: "submenu",
            label: t("species.sortPhotos"),
            inline: true,
            items: SORTS.map((v) => ({
              type: "action",
              label: t(SORT_LABEL[v]),
              checked: v === sort,
              onPress: () => setSort(v),
            })),
          },
        ],
      },
    ],
  });

  if (!data) return <View style={{ flex: 1, backgroundColor: colors.canvas }} />;
  const { mark, photos, facts, all } = data;
  const shaped = all.map((p) => ({ ...p, name }));
  const group = groupOf(species?.taxonClass ?? null);
  const sensitive = !!species && app.isSensitive(scientificName, species.sensitive);
  const photographed = species?.status === "photographed";
  const seenOn = species?.status === "seen" || photographed;
  const region = view.region ? data.regions.find((r) => r.key === view.region)?.name : null;
  // The region's tier named in full ("Uncommon in British Columbia"), then the worldwide one (U2).
  const pills = tierPills(
    t,
    {
      localTier: data.localTier?.tier ?? null,
      localTierReason: data.localTier?.reason,
      worldTier: species?.tier ?? null,
      worldTierReason: species?.tierReason,
    },
    region ?? null,
  ).map((p) => (region ? { text: p.label, label: p.label } : p));
  // The card photo leads, as the hub's square of it; the others follow by rating.
  const cover =
    species?.coverPhotoId && photos.some((p) => p.photoId === species.coverPhotoId) ? species.coverPhotoId : null;
  const heroIds = photos.length
    ? [...new Set([...(cover ? [cover] : []), ...photos.map((p) => p.photoId)])].slice(0, 5)
    : [referenceId(scientificName)];
  const openHero = (p: string) => {
    const i = all.findIndex((x) => x.photoId === p);
    nav.navigate(
      "Viewer",
      i >= 0 ? { ids: all.map((x) => x.photoId), index: i } : { ids: heroIds, index: heroIds.indexOf(p) },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <PhotoGrid
        photos={shaped}
        underBar
        onOpen={(index) => nav.navigate("Viewer", { ids: all.map((x) => x.photoId), index })}
        footer={<View style={{ height: 96 }} />}
        header={
          <View>
            <HeroPager
              ids={heroIds}
              height={HERO}
              // Own photos open full size; the reference photo has no viewer actions that fit it.
              onOpen={photos.length ? openHero : undefined}
              species={cover ? { name: scientificName, cover, crop: species?.cardCrop ?? null } : undefined}
              groupIcon={group.id as IconName}
              groupColor={colors[group.color]}
            />
            {credit ? (
              <Text style={{ color: colors.muted, fontSize: type.footnote.size, paddingHorizontal: 20, paddingTop: 6 }}>
                {t("species.referenceCredit", { credit })}
              </Text>
            ) : null}
            <View style={{ paddingHorizontal: 20, paddingTop: 18 }}>
              <Text
                accessibilityRole="header"
                style={{ color: colors.ink, fontSize: type["title-1"].size, fontWeight: "700" }}
              >
                {name}
              </Text>
              {species?.commonName ? (
                <Text style={{ color: colors.muted, fontSize: type.body.size, fontStyle: "italic", marginTop: 2 }}>
                  {scientificName}
                </Text>
              ) : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10, alignItems: "center" }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 6,
                    backgroundColor: colors.fill,
                  }}
                >
                  <Icon name={group.id as IconName} size={13} color={colors[group.color]} weight="semibold" />
                  <Text
                    style={{
                      color: colors[group.color],
                      fontSize: type.micro.size,
                      fontWeight: "600",
                      letterSpacing: 0.2,
                      textTransform: "uppercase",
                    }}
                  >
                    {t(group.label)}
                  </Text>
                </View>
                {pills.map((p) => (
                  <TierLabel key={p.text} pill={p} />
                ))}
              </View>
            </View>

            <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingTop: 16 }}>
              {photographed ? (
                <Toggle label={t("species.statusPhotographed")} icon="checkFilled" on status />
              ) : (
                <Toggle
                  label={t("species.seenToggle")}
                  icon="seen"
                  on={seenOn}
                  onPress={() => void actions.toggleSeen(target)}
                />
              )}
              <Toggle
                label={t("species.target")}
                icon="target"
                on={!!mark?.isTarget}
                onPress={() => void actions.toggleTarget(target)}
              />
            </View>
            {sensitive ? (
              <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
                <Note text={t("species.locationHidden")} />
              </View>
            ) : null}

            <View style={{ paddingTop: 16 }}>
              <InsetGroup>
                <ListRow
                  title={t("species.firstPhotographed")}
                  value={facts.firstPhotographed ? dateText(t, facts.firstPhotographed) : t("species.none")}
                />
                <ListRow
                  title={t("species.latestPhoto")}
                  value={facts.lastSeen ? dateText(t, facts.lastSeen) : t("species.none")}
                />
                <ListRow title={t("species.photosLabel")} value={String(facts.photos)} />
                {mark?.needsBetterPhoto ? <ListRow title={t("species.needsBetter")} /> : null}
              </InsetGroup>
            </View>

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 20,
                paddingTop: 24,
                paddingBottom: 10,
              }}
            >
              <Text
                accessibilityRole="header"
                style={{ flex: 1, color: colors.ink, fontSize: type["title-3"].size, fontWeight: "700" }}
              >
                {t("species.yourPhotosCount", { n: all.length })}
              </Text>
              {all.length > 1 ? (
                <Button
                  variant="plain"
                  compact
                  label={t(SORT_LABEL[sort])}
                  onPress={() =>
                    showActions(
                      t("species.sortPhotos"),
                      t("common.cancel"),
                      SORTS.map((v) => ({ label: t(SORT_LABEL[v]), onPress: () => setSort(v) })),
                    )
                  }
                />
              ) : null}
            </View>
            {all.length === 0 ? (
              <View style={{ paddingHorizontal: 20 }}>
                <Note text={t("species.noPhotos")} />
              </View>
            ) : null}
          </View>
        }
      />
      <FloatingToolbar>
        <RoundButton
          icon="share"
          label={t("common.share")}
          size={52}
          onPress={() => void Share.share({ message: name })}
        />
      </FloatingToolbar>
    </View>
  );
}
