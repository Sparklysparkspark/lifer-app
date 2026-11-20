import { SymbolView, type AndroidSymbol, type SFSymbol } from "expo-symbols";
import { Platform, type ColorValue } from "react-native";

/** One meaning per icon (T6). SF Symbols on iOS, Material Symbols on Android, from the one table. */
export const ICONS = {
  collection: { ios: "square.grid.2x2.fill", android: "grid_view" },
  gallery: { ios: "photo.on.rectangle.angled", android: "photo_library" },
  albums: { ios: "rectangle.stack.fill", android: "photo_album" },
  trips: { ios: "map.fill", android: "map" },
  identify: { ios: "binoculars.fill", android: "image_search" },
  account: { ios: "person.crop.circle", android: "account_circle" },
  stats: { ios: "chart.bar.fill", android: "bar_chart" },
  regions: { ios: "globe.americas.fill", android: "public" },
  settings: { ios: "gearshape.fill", android: "settings" },
  search: { ios: "magnifyingglass", android: "search" },
  filter: { ios: "line.3.horizontal.decrease", android: "filter_list" },
  more: { ios: "ellipsis", android: "more_vert" },
  target: { ios: "scope", android: "my_location" },
  seen: { ios: "eye", android: "visibility" },
  photographed: { ios: "checkmark.circle.fill", android: "check_circle" },
  favourite: { ios: "heart", android: "favorite" },
  share: { ios: "square.and.arrow.up", android: "share" },
  info: { ios: "info.circle", android: "info" },
  camera: { ios: "camera", android: "photo_camera" },
  choosePhoto: { ios: "photo.on.rectangle", android: "add_photo_alternate" },
  smartAlbum: { ios: "gearshape", android: "auto_awesome_motion" },
  sync: { ios: "arrow.triangle.2.circlepath", android: "sync" },
  offline: { ios: "wifi.slash", android: "wifi_off" },
  close: { ios: "xmark", android: "close" },
  add: { ios: "plus", android: "add" },
  check: { ios: "checkmark", android: "check" },
  chevronRight: { ios: "chevron.right", android: "chevron_right" },
  chevronDown: { ios: "chevron.down", android: "expand_more" },
  mic: { ios: "mic", android: "mic" },
  sliders: { ios: "slider.horizontal.3", android: "tune" },
  photo: { ios: "photo", android: "photo_library" },
  trash: { ios: "trash", android: "delete" },
  checkFilled: { ios: "checkmark.circle.fill", android: "check_circle" },
  grid: { ios: "square.grid.3x3", android: "grid_view" },
  // Group glyphs: SF Symbols and Material stand in for the desktop's own illustrations.
  birds: { ios: "bird.fill", android: "flutter_dash" },
  mammals: { ios: "pawprint.fill", android: "pets" },
  reptiles: { ios: "lizard.fill", android: "pest_control" },
  amphibians: { ios: "tortoise.fill", android: "cruelty_free" },
  fish: { ios: "fish.fill", android: "set_meal" },
  insects: { ios: "ladybug.fill", android: "bug_report" },
  arachnids: { ios: "ladybug.fill", android: "bug_report" },
  other: { ios: "leaf.fill", android: "eco" },
} as const satisfies Record<string, { ios: SFSymbol; android: AndroidSymbol }>;

export type IconName = keyof typeof ICONS;

interface Props {
  name: IconName;
  size?: number;
  color: ColorValue;
  weight?: "regular" | "medium" | "semibold" | "bold";
}

/** A decorative symbol. Whatever uses it carries the spoken label. */
export function Icon({ name, size = 22, color, weight = "medium" }: Props) {
  return (
    <SymbolView
      name={ICONS[name]}
      size={size}
      tintColor={color}
      weight={Platform.OS === "ios" ? weight : undefined}
      resizeMode="scaleAspectFit"
      accessibilityElementsHidden
      importantForAccessibility="no"
    />
  );
}
