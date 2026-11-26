import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

export type TabName = "Collection" | "Gallery" | "Albums" | "Identify";

export type RootParams = {
  Tabs: { screen?: TabName } | undefined;
  Species: { scientificName: string };
  Trip: { id: string };
  Viewer: { ids: string[]; index: number };
  Photos: {
    title: string;
    scope: { kind: "album"; id: string } | { kind: "species"; name: string } | { kind: "trip"; id: string };
  };
  Stats: undefined;
  Regions: undefined;
  Settings: undefined;
  Connect: undefined;
  Welcome: undefined;
  // Sheets, presented as native form sheets over whatever is open.
  YourLifer: undefined;
  RegionPicker: { at?: string } | undefined;
  /** The one Filters sheet, for the Collection or the Gallery. */
  Filters: { scope: "collection" | "gallery" };
  StartTrip: undefined;
  PhotoInfo: { photoId: string };
  ShareSensitive: { photoId: string };
  IdentifyResult: { photoUri: string | null; scientificName?: string };
  AddRegion: undefined;
};

export const useNav = () => useNavigation<NativeStackNavigationProp<RootParams>>();
