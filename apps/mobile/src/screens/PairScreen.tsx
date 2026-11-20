import { useState } from "react";
import { Linking, Text, View } from "react-native";
import { useCameraPermissions } from "expo-camera";
import { useTranslation } from "react-i18next";
import { parsePairingPayload, type CompanionPairingPayload } from "@lifer/shared";
import { PairError, pairErrorKey } from "../connection/pair";
import { typedPairing, type TypedPairing } from "../pairing/entry";
import { QrScanner } from "../pairing/QrScanner";
import { radius, spacing, type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Button, InlineError, Screen, Spinner, TextField } from "../ui";

/** Resolves when paired; throws PairError for a refusal. */
export type Connect = (payload: CompanionPairingPayload) => Promise<void>;
/** Typed pairing with a computer: finds it on the Wi-Fi. Same contract as Connect. */
export type ConnectByCode = (code: string) => Promise<void>;

export function PairScreen({ connect, connectByCode }: { connect: Connect; connectByCode: ConnectByCode }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [permission, askPermission] = useCameraPermissions();
  const [mode, setMode] = useState<"scan" | "type">("scan");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState(false);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");

  async function run(request: CompanionPairingPayload | TypedPairing | null, badEntry = "connect.errors.badEntry") {
    if (!request) return setError(t(badEntry));
    setBusy(true);
    try {
      if ("v" in request) await connect(request);
      else if (request.kind === "computer") await connectByCode(request.code);
      else await connect(request.payload);
    } catch (e) {
      setError(t(e instanceof PairError ? pairErrorKey(e.code) : "connect.errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  // The camera stays off while connecting or showing an error, so one QR is never tried twice.
  const onScan = (text: string) => {
    void run(parsePairingPayload(text), "connect.errors.badCode");
  };
  const submitTyped = () => {
    setError(null);
    void run(typedPairing(code, server ? address : ""));
  };

  if (busy) {
    return (
      <Screen safeTop>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.item }}>
          <Spinner label={t("pair.connecting")} />
          <Text style={{ color: colors.muted, fontSize: type["title-3"].size }}>{t("pair.connecting")}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen safeTop>
      <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type["title-1"].size, fontWeight: "700" }}>
        {t(mode === "scan" ? "pair.title" : "pair.typeTitle")}
      </Text>
      <Text style={{ color: colors.muted, fontSize: type.body.size }}>
        {t(mode === "scan" ? "pair.scanSteps" : "pair.typeSteps")}
      </Text>
      {error ? <InlineError message={error} /> : null}

      {mode === "scan" ? (
        <>
          {error ? (
            <Button label={t("pair.tryAgain")} onPress={() => setError(null)} />
          ) : permission?.granted ? (
            <View
              accessibilityLabel={t("pair.cameraLabel")}
              style={{ aspectRatio: 1, borderRadius: radius.panel, overflow: "hidden", backgroundColor: colors.ink }}
            >
              <QrScanner onScan={onScan} />
            </View>
          ) : permission ? (
            <View style={{ gap: spacing.item }}>
              <Text style={{ color: colors.ink, fontSize: type.body.size }}>
                {t(permission.canAskAgain ? "pair.cameraWhy" : "pair.cameraDenied")}
              </Text>
              {permission.canAskAgain ? (
                <Button label={t("pair.allowCamera")} onPress={() => void askPermission()} />
              ) : (
                <Button label={t("pair.openSettings")} onPress={() => void Linking.openSettings()} />
              )}
            </View>
          ) : (
            <Spinner label={t("pair.connecting")} />
          )}
          <Button
            variant="plain"
            label={t("pair.typeInstead")}
            onPress={() => {
              setError(null);
              setMode("type");
            }}
          />
        </>
      ) : (
        <>
          <TextField
            label={t("pair.code")}
            hint={t("pair.codeHint")}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            maxLength={7}
            autoComplete="off"
          />
          {server ? (
            <TextField
              label={t("pair.serverAddress")}
              hint={t("pair.serverAddressHint")}
              value={address}
              onChangeText={setAddress}
              autoCapitalize="none"
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={submitTyped}
            />
          ) : null}
          <Button label={t("pair.connect")} onPress={submitTyped} />
          <Button
            variant="plain"
            label={t(server ? "pair.useComputer" : "pair.useServer")}
            onPress={() => {
              setError(null);
              setServer(!server);
            }}
          />
          <Button
            variant="plain"
            label={t("pair.scanInstead")}
            onPress={() => {
              setError(null);
              setMode("scan");
            }}
          />
        </>
      )}
    </Screen>
  );
}
