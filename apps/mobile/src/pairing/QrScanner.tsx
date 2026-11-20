import { requireNativeView } from "expo";
import { CameraView } from "expo-camera";
import { Platform, type ViewProps } from "react-native";

// iPhone: Apple's own scanner through expo-camera. Android: the ZXing view in modules/qr-scanner,
// so no Google ML Kit or Play Services code is in the app. Both read offline.
const AndroidScanner =
  Platform.OS === "android"
    ? requireNativeView<ViewProps & { onScan: (e: { nativeEvent: { data: string } }) => void }>("QrScanner")
    : null;

export function QrScanner({ onScan }: { onScan: (text: string) => void }) {
  if (AndroidScanner) {
    return <AndroidScanner style={{ flex: 1 }} onScan={(e) => onScan(e.nativeEvent.data)} />;
  }
  return (
    <CameraView
      style={{ flex: 1 }}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      onBarcodeScanned={(r) => onScan(r.data)}
    />
  );
}
