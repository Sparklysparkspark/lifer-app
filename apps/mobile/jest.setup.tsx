// Native modules the screens touch, replaced with plain stand-ins; navigation is a recording stub.
jest.mock("expo-image", () => ({ Image: "Image" }));
jest.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
jest.mock("expo-haptics", () => ({
  notificationAsync: jest.fn(async () => undefined),
  selectionAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: "success" },
}));
jest.mock("expo-symbols", () => ({
  SymbolView: "SymbolView",
  unstable_getMaterialSymbolSourceAsync: jest.fn(async () => null),
}));
jest.mock("expo-glass-effect", () => ({ GlassView: "GlassView", isLiquidGlassAvailable: () => false }));
jest.mock("@react-native-segmented-control/segmented-control", () => ({
  __esModule: true,
  default: "SegmentedControl",
}));
jest.mock("react-native-gesture-handler", () => {
  const chain: Record<string, unknown> = new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => chain) });
  return {
    Gesture: {
      Pinch: () => chain,
      Pan: () => chain,
      Tap: () => chain,
      Simultaneous: () => chain,
      Exclusive: () => chain,
    },
    GestureDetector: ({ children }: { children: unknown }) => children,
    GestureHandlerRootView: ({ children }: { children: unknown }) => children,
  };
});
jest.mock("@shopify/flash-list", () => {
  const { FlatList } = jest.requireActual<typeof import("react-native")>("react-native");
  return { FlashList: FlatList };
});
jest.mock("@react-navigation/native", () => ({
  ...jest.requireActual<object>("@react-navigation/native"),
  useIsFocused: () => true,
}));
jest.mock("expo-location", () => ({
  Accuracy: { Balanced: 3 },
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: false })),
  getLastKnownPositionAsync: jest.fn(async () => null),
  getCurrentPositionAsync: jest.fn(async () => ({ coords: { latitude: 52.5, longitude: 1.0 } })),
}));
jest.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}));
jest.mock("expo-sharing", () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
jest.mock("expo-modules-core", () => ({ requireNativeModule: () => ({}) }));
jest.mock("expo-file-system", () => ({ File: class {}, Directory: class {}, Paths: {} }));
jest.mock("./src/navigation/types", () => {
  const nav = { navigate: jest.fn(), goBack: jest.fn(), canGoBack: jest.fn(() => false), setOptions: jest.fn() };
  return { useNav: () => nav, __nav: nav };
});
