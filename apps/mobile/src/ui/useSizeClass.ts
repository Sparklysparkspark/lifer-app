import { useWindowDimensions } from "react-native";
import { columnsFor, SHORT_HEIGHT, sizeClassOf, type SizeClass } from "./sizeClass";

export interface SizeInfo {
  sizeClass: SizeClass;
  shortHeight: boolean;
  /** Columns that fit the window at a minimum card width. */
  columns: (min: number) => number;
}

/** The one place layout reads the window width: it follows the window, never the device, and changes live. */
export function useSizeClass(): SizeInfo {
  const { width, height } = useWindowDimensions();
  return {
    sizeClass: sizeClassOf(width),
    shortHeight: height < SHORT_HEIGHT,
    columns: (min) => columnsFor(width, min),
  };
}
