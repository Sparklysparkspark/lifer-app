// expo-camera's own option removes the ML Kit barcode scanner; this removes its document scanner
// (also Google Play Services) so nothing from ML Kit ships on Android.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withGradleProperties } = require("expo/config-plugins");

module.exports = (config) =>
  withGradleProperties(config, (c) => {
    c.modResults = c.modResults.filter((p) => p.key !== "expo.camera.document-scanner-enabled");
    c.modResults.push({ type: "property", key: "expo.camera.document-scanner-enabled", value: "false" });
    return c;
  });
