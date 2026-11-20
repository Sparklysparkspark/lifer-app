import { ActionSheetIOS, Alert, Platform } from "react-native";

export interface MenuAction {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

/**
 * A short list of choices from a long press: the system action sheet on iOS, the alert's buttons on Android.
 * Every choice here also exists as a visible control on the page (MR12).
 */
export function showActions(title: string, cancel: string, actions: MenuAction[]): void {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...actions.map((a) => a.label), cancel],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.findIndex((a) => a.destructive) >= 0 ? actions.findIndex((a) => a.destructive) : undefined,
      },
      (i) => actions[i]?.onPress(),
    );
    return;
  }
  Alert.alert(title, undefined, [...actions.slice(0, 2).map((a) => ({ text: a.label, onPress: a.onPress })), { text: cancel, style: "cancel" }]);
}
