import SegmentedControl, {
  type NativeSegmentedControlIOSChangeEvent,
  type SegmentedControlProps,
} from "@react-native-segmented-control/segmented-control";
import type { ComponentType } from "react";
import type { NativeSyntheticEvent } from "react-native";
import { View } from "react-native";
import { spacing } from "../theme/theme";
import { useTheme } from "../theme/useTheme";

interface Props {
  values: string[];
  selected: number;
  onChange: (index: number) => void;
  label: string;
  /** Sits at the trailing edge of a list row instead of across the screen. */
  inline?: boolean;
}

// The package types its class for the old JSX rules; this is the same component as a plain one.
const Control = SegmentedControl as unknown as ComponentType<SegmentedControlProps>;

/** The platform segmented control (UISegmentedControl). */
export function Segmented({ values, selected, onChange, label, inline }: Props) {
  const { appearance } = useTheme();
  return (
    <View style={inline ? { minWidth: 180 } : { paddingHorizontal: spacing.gutter, paddingTop: 14, paddingBottom: 4 }}>
      <Control
        accessibilityLabel={label}
        values={values}
        selectedIndex={selected}
        onChange={(e: NativeSyntheticEvent<NativeSegmentedControlIOSChangeEvent>) =>
          onChange(e.nativeEvent.selectedSegmentIndex)
        }
        appearance={appearance === "dark" ? "dark" : "light"}
      />
    </View>
  );
}
