import { Platform } from "react-native";
import { createNativeStackNavigator, type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { useTranslation } from "react-i18next";
import { useTheme } from "../theme/useTheme";
import { AddRegionScreen } from "../screens/AddRegionScreen";
import { ConnectScreen } from "../screens/ConnectScreen";
import { IdentifyResultSheet } from "../screens/IdentifyResultSheet";
import { MoreFiltersSheet } from "../screens/MoreFiltersSheet";
import { PhotoInfoSheet } from "../screens/PhotoInfoSheet";
import { PhotosScreen } from "../screens/PhotosScreen";
import { RegionPickerSheet } from "../screens/RegionPickerSheet";
import { RegionsScreen } from "../screens/RegionsScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { SpeciesScreen } from "../screens/SpeciesScreen";
import { ShareSensitiveSheet } from "../screens/ShareSensitiveSheet";
import { StartTripSheet } from "../screens/StartTripSheet";
import { StatsScreen } from "../screens/StatsScreen";
import { TripScreen } from "../screens/TripScreen";
import { ViewerScreen } from "../screens/ViewerScreen";
import { WelcomeScreen } from "../screens/WelcomeScreen";
import { YourLiferSheet } from "../screens/YourLiferSheet";
import { useApp } from "../app/AppContext";
import type { RootParams } from "./types";
import { Tabs, useStackOptions } from "./TabNavigator";

const Stack = createNativeStackNavigator<RootParams>();

/** A native form sheet: grabber, rounded top, detents; its own small title bar with the close button. */
function useSheet() {
  const { colors } = useTheme();
  return (detents: number[] | "fitToContents", extra: NativeStackNavigationOptions = {}): NativeStackNavigationOptions => ({
    presentation: "formSheet",
    sheetAllowedDetents: detents,
    sheetGrabberVisible: true,
    sheetCornerRadius: 38,
    headerShown: true,
    headerLargeTitleEnabled: false,
    headerTransparent: false,
    headerShadowVisible: false,
    headerStyle: { backgroundColor: colors.canvas },
    headerTintColor: colors.link,
    headerTitleStyle: { color: colors.ink, fontWeight: "600" },
    contentStyle: { backgroundColor: colors.canvas },
    ...extra,
  });
}

/** First run, before the person has chosen: connect to a Lifer or use the app on its own. */
export function FirstRun() {
  const app = useApp();
  const { colors } = useTheme();
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }}>
      <Stack.Screen name="Welcome">
        {({ navigation }) => <WelcomeScreen onConnect={() => navigation.navigate("Connect")} onStandalone={() => void app.chooseStandalone()} />}
      </Stack.Screen>
      <Stack.Screen name="Connect" component={ConnectScreen} />
    </Stack.Navigator>
  );
}

export function Main() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const stack = useStackOptions();
  const sheet = useSheet();
  // Pushed pages keep the transparent bar; the species and viewer pages draw their own chrome over a photo.
  const page: NativeStackNavigationOptions = { ...stack, headerLargeTitleEnabled: false, headerTransparent: Platform.OS === "ios" };
  return (
    <Stack.Navigator screenOptions={{ headerBackButtonDisplayMode: "minimal", contentStyle: { backgroundColor: colors.canvas } }}>
      <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
      <Stack.Screen name="Species" component={SpeciesScreen} options={{ ...page, title: "", headerTransparent: true }} />
      <Stack.Screen name="Trip" component={TripScreen} options={{ ...stack, title: "" }} />
      <Stack.Screen name="Photos" component={PhotosScreen} options={{ ...stack, title: "" }} />
      <Stack.Screen name="Stats" component={StatsScreen} options={{ ...stack, title: t("stats.title") }} />
      <Stack.Screen name="Regions" component={RegionsScreen} options={{ ...stack, title: t("regions.title") }} />
      <Stack.Screen name="Settings" component={SettingsScreen} options={{ ...stack, title: t("settings.title") }} />
      <Stack.Screen name="Connect" component={ConnectScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Viewer" component={ViewerScreen} options={{ headerShown: false, presentation: "transparentModal", animation: "fade", contentStyle: { backgroundColor: "transparent" } }} />
      <Stack.Screen name="YourLifer" component={YourLiferSheet} options={sheet([0.62, 1], { title: t("account.title") })} />
      <Stack.Screen name="RegionPicker" component={RegionPickerSheet} options={sheet([0.7, 1], { title: t("regionPicker.title") })} />
      <Stack.Screen name="MoreFilters" component={MoreFiltersSheet} options={sheet([0.75, 1], { title: t("collection.moreFilters") })} />
      <Stack.Screen name="StartTrip" component={StartTripSheet} options={sheet([0.7, 1], { title: t("trips.start") })} />
      <Stack.Screen name="PhotoInfo" component={PhotoInfoSheet} options={sheet([0.5, 1], { title: t("viewer.info") })} />
      <Stack.Screen name="ShareSensitive" component={ShareSensitiveSheet} options={sheet([0.4], { title: t("viewer.shareSensitiveTitle") })} />
      <Stack.Screen name="IdentifyResult" component={IdentifyResultSheet} options={sheet([0.55, 1], { title: t("identify.resultTitle") })} />
      <Stack.Screen name="AddRegion" component={AddRegionScreen} options={sheet([0.85, 1], { title: t("regions.add") })} />
    </Stack.Navigator>
  );
}
