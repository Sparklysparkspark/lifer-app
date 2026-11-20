import { useEffect } from "react";
import { Platform, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp } from "../app/AppContext";
import { discoverHubs, nativeRandom, pairWithCode, pairWithHub, transportFor, type PairedHub } from "../connection";
import { useNav } from "../navigation/types";
import { Button } from "./../ui";
import { PairScreen, type Connect, type ConnectByCode } from "./PairScreen";

// The device name the hub lists under Phones. No device-info package: the model where Android gives it.
const deviceName = (): string =>
  Platform.OS === "ios" ? "iPhone" : ((Platform.constants as { Model?: string }).Model ?? "Android phone");
const device = () => ({ deviceName: deviceName(), platform: Platform.OS === "ios" ? "ios" : "android" }) as const;

/** Pairing, reached from the first screen or from Settings. Keeps working with the key it gets. */
export function ConnectScreen({ done }: { done?: () => void }) {
  const { t } = useTranslation();
  const app = useApp();
  const nav = useNav();
  const connect: Connect = async (payload) => {
    const paired: PairedHub = await pairWithHub(payload, device(), transportFor);
    await app.connected(paired);
  };
  const connectByCode: ConnectByCode = async (code) => {
    const paired = await pairWithCode(code, device(), { transport: transportFor, discover: discoverHubs, random: nativeRandom });
    await app.connected(paired);
  };
  // Back to wherever pairing was started from once it worked (Settings), when there is somewhere to go.
  useEffect(() => {
    if (app.paired && nav.canGoBack()) nav.goBack();
  }, [app.paired, nav]);
  return (
    <View style={{ flex: 1 }}>
      <PairScreen connect={connect} connectByCode={connectByCode} />
      <View style={{ padding: 16 }}>
        <Button variant="plain" label={t("welcome.back")} onPress={() => (done ? done() : nav.goBack())} />
      </View>
    </View>
  );
}
