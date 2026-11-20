import { useEffect, useMemo, useRef, useState } from "react";
import { NavigationContainer, DarkTheme, DefaultTheme } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import "./i18n";
import { AppProvider, useApp, type Boot } from "./app/AppContext";
import { bootApp } from "./app/boot";
import { CollectionViewProvider } from "./collection/view";
import { FirstRun, Main } from "./navigation/Root";
import { REGIONS_SETUP_KEY, RegionsSetupScreen } from "./screens/RegionsSetupScreen";
import { getMeta } from "./store/meta";
import { listRegions } from "./store/regions";
import { navigationRef } from "./navigation/ref";
import { useTheme } from "./theme/useTheme";
import { ToastProvider } from "./ui";

function Shell() {
  const app = useApp();
  const { appearance, colors } = useTheme();
  const base = appearance === "dark" ? DarkTheme : DefaultTheme;
  const theme = useMemo(
    () => ({
      ...base,
      colors: { ...base.colors, primary: colors.link, background: colors.canvas, card: colors.surface, text: colors.ink, border: colors.line },
    }),
    [base, colors],
  );
  // A phone on its own asks once which regions to keep; a paired one mirrors its hub's with no asking.
  const [setup, setSetup] = useState<boolean | null>(null);
  useEffect(() => {
    void (async () => setSetup(!!(await getMeta(app.db, REGIONS_SETUP_KEY)) || (await listRegions(app.db)).length > 0))();
  }, [app.db, app.mode]);
  const latest = useRef(app);
  latest.current = app;
  useEffect(() => {
    if (!__DEV__) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dev tooling stays out of release bundles
    return (require("./dev/devDriver") as { startDevDriver: (get: () => typeof app) => () => void }).startDevDriver(() => latest.current);
  }, []);
  return (
    <NavigationContainer theme={theme} ref={navigationRef}>
      {app.mode === null ? <FirstRun /> : app.mode === "standalone" && setup === false ? <RegionsSetupScreen onDone={() => setSetup(true)} /> : <Main />}
      <StatusBar style={appearance === "dark" ? "light" : "dark"} />
    </NavigationContainer>
  );
}

// Nothing waits on a hub at launch: the database opens, the screens read it, the sync fills it in.
export default function App() {
  const [boot, setBoot] = useState<Boot | null>(null);
  useEffect(() => void bootApp().then(setBoot), []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {boot ? (
          <AppProvider boot={boot}>
            <CollectionViewProvider>
              <ToastProvider>
                <Shell />
              </ToastProvider>
            </CollectionViewProvider>
          </AppProvider>
        ) : null}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
