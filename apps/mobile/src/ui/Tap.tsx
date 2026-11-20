import type { ReactNode } from "react";
import {
  Pressable,
  type AccessibilityActionEvent,
  type AccessibilityRole,
  type StyleProp,
  type ViewStyle,
} from "react-native";

export interface TapAction {
  name: string;
  label: string;
  onPress: () => void;
}

interface Props {
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  hint?: string;
  role?: AccessibilityRole;
  selected?: boolean;
  /** A switch's state; with role "switch". */
  checked?: boolean;
  disabled?: boolean;
  /** Extra VoiceOver actions (the same choices as the long press menu, MR12). */
  actions?: TapAction[];
  style?: StyleProp<ViewStyle>;
  /** Fades the content on press (default) or leaves it to the caller. */
  children: ReactNode | ((pressed: boolean) => ReactNode);
}

/** The one touchable the screens build on: always labelled, never a bare Pressable (MR15). */
export function Tap({
  label,
  onPress,
  onLongPress,
  hint,
  role = "button",
  selected,
  checked,
  disabled,
  actions,
  style,
  children,
}: Props) {
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{
        disabled: !!disabled,
        ...(selected === undefined ? {} : { selected }),
        ...(checked === undefined ? {} : { checked }),
      }}
      accessibilityActions={actions?.map((a) => ({ name: a.name, label: a.label }))}
      onAccessibilityAction={(e: AccessibilityActionEvent) =>
        actions?.find((a) => a.name === e.nativeEvent.actionName)?.onPress()
      }
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        { opacity: disabled ? 0.5 : pressed && typeof children !== "function" ? 0.7 : 1 },
        style,
      ]}
    >
      {({ pressed }) => (typeof children === "function" ? children(pressed) : children)}
    </Pressable>
  );
}
