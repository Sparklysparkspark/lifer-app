import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import { createNativeStackNavigator, type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { unstable_getMaterialSymbolSourceAsync } from "expo-symbols";
import { useTranslation } from "react-i18next";
import { useApp, useLocal } from "../app/AppContext";
import { AlbumsScreen } from "../screens/AlbumsScreen";
import { CollectionScreen } from "../screens/CollectionScreen";
import { GalleryScreen } from "../screens/GalleryScreen";
import { IdentifyScreen } from "../screens/IdentifyScreen";
import { PhotosScreen } from "../screens/PhotosScreen";
import { listTrips } from "../store/library";
import { regionKeysByHubId, regionProgress } from "../store/regions";
import { tripCovers } from "../store/browse";
import { useTheme } from "../theme/useTheme";
import { ICONS, TripAccessory, showActions, type AccessoryTrip } from "../ui";
import { TAB_BAR, TRIP_BAR, TabClearanceContext } from "./clearance";
import { TABS } from "./tabs";
import { useNav, type RootParams, type TabName } from "./types";

const Tab = createNativeBottomTabNavigator();
const Stack = createNativeStackNavigator<Pick<RootParams, "Photos"> & Record<`${TabName}Home`, undefined>>();

const today = () => new Date().toISOString().slice(0, 10);

/** Options every tab's stack shares: a large title that collapses, the canvas colour, the sage tint. */
export function useStackOptions(): NativeStackNavigationOptions {
  const { colors } = useTheme();
  return {
    headerLargeTitleEnabled: true,
    headerTransparent: Platform.OS === "ios",
    headerLargeStyle: { backgroundColor: colors.canvas },
    headerLargeTitleStyle: { color: colors.ink, fontWeight: "700" },
    headerTitleStyle: { color: colors.ink, fontWeight: "600" },
    headerTintColor: colors.link,
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal",
    contentStyle: { backgroundColor: colors.canvas },
  };
}

function TabStack({ name, component }: { name: TabName; component: () => React.JSX.Element }) {
  const options = useStackOptions();
  return (
    <Stack.Navigator screenOptions={options}>
      <Stack.Screen name={`${name}Home`} component={component} />
      {name === "Albums" ? <Stack.Screen name="Photos" component={PhotosScreen} /> : null}
    </Stack.Navigator>
  );
}

const STACKS: Record<TabName, () => React.JSX.Element> = {
  Collection: () => <TabStack name="Collection" component={CollectionScreen} />,
  Gallery: () => <TabStack name="Gallery" component={GalleryScreen} />,
  Albums: () => <TabStack name="Albums" component={AlbumsScreen} />,
  Identify: () => <TabStack name="Identify" component={IdentifyScreen} />,
};

/** The active trip, with how far through its region's list the person is, for the bar above the tabs. */
function useActiveTrip(): AccessoryTrip | null {
  const { data } = useLocal(async (db) => {
    const trip = (await listTrips(db, today())).find((x) => x.active) ?? null;
    if (!trip) return null;
    const keys = trip.regionId ? await regionKeysByHubId(db, trip.regionId) : [];
    const progress = keys.length ? await regionProgress(db, keys[0]) : null;
    return {
      id: trip.id,
      name: trip.name,
      seen: progress?.seen ?? null,
      total: progress?.total ?? null,
      coverPhotoId: (await tripCovers(db))[trip.id] ?? null,
    };
  });
  return data ?? null;
}

/** Material Symbol images for the Android tab bar, drawn once. */
function useAndroidTabIcons(color: string) {
  const [icons, setIcons] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (Platform.OS !== "android") return;
    void Promise.all(
      TABS.map(
        async (t) => [t.name, await unstable_getMaterialSymbolSourceAsync(ICONS[t.icon].android, 24, color)] as const,
      ),
    ).then((e) => setIcons(Object.fromEntries(e)));
  }, [color]);
  return icons;
}

/** Four native tabs (UITabBarController with Liquid Glass; Material navigation bar on Android). */
export function Tabs() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const app = useApp();
  const nav = useNav();
  const trip = useActiveTrip();
  const androidIcons = useAndroidTabIcons(colors.muted);
  const showBar = trip && app.settings.hiddenTripBar !== trip.id;

  const accessory = showBar
    ? ({ placement }: { placement: "regular" | "inline" }) => (
        <TripAccessory
          trip={trip}
          placement={placement}
          onOpen={() => nav.navigate("Trip", { id: trip.id })}
          onMenu={() =>
            showActions(trip.name, t("common.cancel"), [
              { label: t("trips.hideAccessory"), onPress: () => void app.updateSettings({ hiddenTripBar: trip.id }) },
            ])
          }
        />
      )
    : undefined;

  const clearance = Platform.OS === "ios" ? TAB_BAR + (showBar ? TRIP_BAR : 0) : 0;
  return (
    <TabClearanceContext.Provider value={clearance}>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.link,
          tabBarInactiveTintColor: colors.muted,
          tabBarActiveIndicatorColor: colors.accentTint,
          tabBarLabelStyle: { fontSize: 10, fontWeight: "600" },
        }}
      >
        {TABS.map((tab) => (
          <Tab.Screen
            key={tab.name}
            name={tab.name}
            component={STACKS[tab.name]}
            options={{
              title: t(tab.label),
              tabBarLabel: t(tab.label),
              tabBarIcon:
                Platform.OS === "ios"
                  ? { type: "sfSymbol", name: ICONS[tab.icon].ios }
                  : androidIcons[tab.name]
                    ? { type: "image", source: androidIcons[tab.name] as never }
                    : undefined,
              tabBarMinimizeBehavior: tab.name === "Gallery" || tab.name === "Albums" ? "onScrollDown" : "none",
              bottomAccessory: accessory,
            }}
          />
        ))}
      </Tab.Navigator>
    </TabClearanceContext.Provider>
  );
}
